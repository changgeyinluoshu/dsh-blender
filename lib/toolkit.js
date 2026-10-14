/**
 * 零依赖的 `defineTool` 等价实现。
 *
 * DSH 的 `@deepseek-ai/dsh-tools` 提供 defineTool，但第三方插件的模块解析
 * 不保证一定能拿到该包。本插件刻意不依赖任何 npm 包：从 GitHub 下载即可用，
 * 不需要 pnpm/npm install。这里生成的参数 schema 与官方
 * `parameterSchemaSpecToJsonSchema` 保持一致（对象根、required 数组、
 * 不隐式关闭 additionalProperties），输出的 output 结构与官方 register()
 * 的校验要求一致（必须有 output.render 函数）。
 */

/** 形如 `{ type: 'array', items: { type: 'string' } }` 的参数说明。 */
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

/**
 * 把一条参数说明转换为 JSON Schema 片段。
 * @param {object} def 参数说明。
 * @returns {object} JSON Schema 片段。
 */
export function toJsonSchema(def) {
  const spec = def && typeof def === 'object' ? def : { type: 'string' }
  const schema = {}
  const type = JSON_TYPES.has(spec.type) ? spec.type : 'string'
  schema.type = type
  if (typeof spec.description === 'string' && spec.description) schema.description = spec.description
  if (Array.isArray(spec.enum) && spec.enum.length > 0) schema.enum = spec.enum.slice()
  if (type === 'array') schema.items = spec.items ? toJsonSchema(spec.items) : { type: 'string' }
  if (type === 'object') {
    const properties = {}
    for (const [key, value] of Object.entries(spec.properties ?? {})) properties[key] = toJsonSchema(value)
    schema.properties = properties
    if (Array.isArray(spec.required) && spec.required.length > 0) schema.required = spec.required.slice()
  }
  if (spec.default !== undefined) schema.default = spec.default
  if (Number.isFinite(spec.minimum)) schema.minimum = spec.minimum
  if (Number.isFinite(spec.maximum)) schema.maximum = spec.maximum
  return schema
}

/**
 * 把参数说明表编译成工具参数 JSON Schema。
 * @param {Record<string, object>} spec 参数说明表。
 * @returns {object} 对象根 JSON Schema。
 */
export function toParameterSchema(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, def] of Object.entries(spec)) {
    properties[key] = toJsonSchema(def)
    if (def && def.required === true) required.push(key)
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

/** 默认渲染器：把结构化结果序列化为文本内容块。 */
export function renderJSON(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  return [{ type: 'text', text }]
}

/**
 * 定义一个注册到 ctx.tools 的工具。
 * @param {object} options 工具定义。
 * @returns {object} 符合 ctx.tools.register() 契约的工具对象。
 */
export function defineTool(options) {
  const { name, description, parameters = {}, output, execute, timeoutMs } = options
  if (!name || typeof name !== 'string') throw new TypeError('defineTool: name is required')
  if (typeof execute !== 'function') throw new TypeError(`defineTool(${name}): execute must be a function`)
  const tool = {
    name,
    description,
    parameters: toParameterSchema(parameters),
    output: {
      schema: output?.schema ?? { type: 'object', additionalProperties: true },
      render: typeof output?.render === 'function' ? output.render : renderJSON,
    },
    async execute(args, exec) {
      return execute(args ?? {}, exec ?? {})
    },
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) tool.timeoutMs = timeoutMs
  return tool
}

/** 便捷工具：把值转成模型可读的一行 JSON 摘要。 */
export function jsonLine(value) {
  return JSON.stringify(value)
}
