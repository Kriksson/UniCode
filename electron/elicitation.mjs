const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsupported = () => { throw new Error('Эта форма содержит неподдерживаемые поля. Запрос можно отклонить.'); };
const known = (value, keys) => { if (Object.keys(value).some(key => !keys.includes(key))) unsupported(); };
const formats = ['email', 'uri', 'date', 'date-time'];
function choices(schema) {
  if (Array.isArray(schema.enum)) return schema.enum.map((value, index) => ({ value, label: schema.enumNames?.[index] || value }));
  const options = schema.oneOf || schema.anyOf;
  if (Array.isArray(options)) return options.map(option => {
    if (!object(option)) unsupported();
    known(option, ['const', 'title', 'description']);
    return { value: option.const, label: option.title || option.const };
  });
  return undefined;
}

/** One schema interpretation for both the form and the outgoing protocol response. */
export function elicitationForm(params) {
  const mode = params.mode || (params.requestedSchema ? 'form' : '');
  if (mode === 'url') {
    let url;
    try { url = new URL(params.url); } catch { throw new Error('Инструмент прислал некорректную ссылку.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Этот тип ссылки не поддерживается.');
    return { mode: 'url', url: url.href, fields: [] };
  }
  if (!['form', 'openai/form', 'openaiForm'].includes(mode)) unsupported();
  const schema = params.requestedSchema;
  if (!object(schema) || schema.type !== 'object' || !object(schema.properties)) unsupported();
  known(schema, ['$schema', 'type', 'properties', 'required', 'title', 'description', 'additionalProperties']);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key)))) unsupported();
  const entries = Object.entries(schema.properties);
  if (entries.length > 40) unsupported();
  const fields = entries.map(([key, value]) => {
    if (!object(value) || !['string', 'boolean', 'number', 'integer', 'array'].includes(value.type)) unsupported();
    known(value, ['type', 'title', 'description', 'default', 'enum', 'enumNames', 'oneOf', 'minLength', 'maxLength', 'format', 'minimum', 'maximum', 'items', 'minItems', 'maxItems']);
    if ((value.title !== undefined && typeof value.title !== 'string') || (value.description !== undefined && typeof value.description !== 'string')) unsupported();
    for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) {
      if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) unsupported();
    }
    if (value.format && !formats.includes(value.format)) unsupported();
    let options = choices(value);
    if (value.type === 'array') {
      if (!object(value.items)) unsupported();
      known(value.items, ['type', 'enum', 'anyOf']);
      if (value.items.type !== undefined && value.items.type !== 'string') unsupported();
      options = choices(value.items);
      if (!options) unsupported();
    }
    if (options && !['string', 'array'].includes(value.type)) unsupported();
    if (options && (!options.length || options.length > 200 || options.some(option => typeof option.value !== 'string' || typeof option.label !== 'string'))) unsupported();
    return { ...value, key, label: value.title || key, required: schema.required?.includes(key) || false, options };
  });
  return { mode: 'form', fields };
}

export function elicitationResponse(params, decision, content) {
  if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Выберите подтверждение или отказ.');
  if (decision !== 'accept') return { action: decision, content: null, _meta: null };
  const form = elicitationForm(params);
  if (form.mode === 'url') return { action: 'accept', content: null, _meta: null };
  if (!object(content) || JSON.stringify(content).length > 100000) throw new Error('Неверный ответ формы.');
  if (Object.keys(content).some(key => !form.fields.some(field => field.key === key))) throw new Error('В ответе есть неизвестные поля.');
  for (const field of form.fields) {
    const value = content[field.key];
    const invalid = () => { throw new Error(`Проверьте поле «${field.label}».`); };
    if (!Object.hasOwn(content, field.key)) { if (field.required) invalid(); continue; }
    if (field.type === 'boolean' && typeof value !== 'boolean') invalid();
    if (field.type === 'number' || field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))
        || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) invalid();
    }
    if (field.type === 'string') {
      if (typeof value !== 'string') invalid();
      const length = [...value].length;
      if ((field.minLength !== undefined && length < field.minLength) || (field.maxLength !== undefined && length > field.maxLength)) invalid();
      if (field.options && !field.options.some(option => option.value === value)) invalid();
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid();
      if (field.format === 'uri') { try { new URL(value); } catch { invalid(); } }
      if (field.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) invalid();
      if (field.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))) invalid();
    }
    if (field.type === 'array') {
      if (!Array.isArray(value) || value.some(item => !field.options.some(option => option.value === item)) || new Set(value).size !== value.length
        || (field.minItems !== undefined && value.length < field.minItems) || (field.maxItems !== undefined && value.length > field.maxItems)) invalid();
    }
  }
  return { action: 'accept', content, _meta: null };
}
