type JsonSchema = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function resolveReference(root: JsonSchema, reference: string): JsonSchema {
  if (!reference.startsWith("#/"))
    throw new TypeError(`Unsupported schema reference: ${reference}`);
  let current: unknown = root;
  for (const token of reference.slice(2).split("/"))
    current = record(current, reference)[token.replaceAll("~1", "/").replaceAll("~0", "~")];
  return record(current, reference);
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

/** Validate the JSON-Schema subset used by the committed public machine contracts. */
export function assertSchemaConformance(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema = schema,
  path = "$",
): void {
  if (typeof schema.$ref === "string") {
    assertSchemaConformance(value, resolveReference(root, schema.$ref), root, path);
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        assertSchemaConformance(value, record(candidate, `${path}.oneOf`), root, path);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw new TypeError(`${path} must match exactly one schema branch`);
    return;
  }
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const))
    throw new TypeError(`${path} does not match the required constant`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value)))
    throw new TypeError(`${path} is not an allowed enum value`);
  const types = Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type)))
    throw new TypeError(`${path} must have type ${types.join("|")}`);
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum)
    throw new RangeError(`${path} is below its minimum`);
  if (typeof value === "string" && typeof schema.pattern === "string") {
    if (!new RegExp(schema.pattern, "u").test(value)) throw new TypeError(`${path} is invalid`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      throw new RangeError(`${path} has too few items`);
    if (schema.items)
      value.forEach((entry, index) =>
        assertSchemaConformance(
          entry,
          record(schema.items, `${path}.items`),
          root,
          `${path}[${index}]`,
        ),
      );
    return;
  }
  if (!isRecord(value)) return;
  const object = value;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  for (const name of required)
    if (!Object.hasOwn(object, name)) throw new TypeError(`${path}.${name} is required`);
  const properties = schema.properties ? record(schema.properties, `${path}.properties`) : {};
  for (const [name, entry] of Object.entries(object)) {
    const property = properties[name];
    if (property) {
      assertSchemaConformance(entry, record(property, `${path}.${name}`), root, `${path}.${name}`);
      continue;
    }
    if (schema.additionalProperties === false)
      throw new TypeError(`${path}.${name} is not allowed`);
    if (schema.additionalProperties && typeof schema.additionalProperties === "object")
      assertSchemaConformance(
        entry,
        record(schema.additionalProperties, `${path}.additionalProperties`),
        root,
        `${path}.${name}`,
      );
  }
}
