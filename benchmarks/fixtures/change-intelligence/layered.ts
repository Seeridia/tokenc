import type { ContextDefinition, TokenSourceInput } from "@tokenc/core";

export const LAYERED_TOKEN_COUNT = 1_200;
export const LAYERED_REFERENCE_COUNT = 800;

export const LAYERED_CONTEXTS: ContextDefinition = Object.freeze({
  theme: Object.freeze({ default: "light", values: Object.freeze(["light", "dark"]) }),
  density: Object.freeze({
    default: "comfortable",
    values: Object.freeze(["comfortable", "compact"]),
  }),
});

function source(path: string, value: unknown): TokenSourceInput {
  return {
    file: `/benchmark/change-intelligence/${path}`,
    content: JSON.stringify(value),
  };
}

function primitives(changed: boolean): TokenSourceInput {
  return source("primitive.tokens.json", {
    primitive: Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [
        `scale${index}`,
        {
          $type: "number",
          $value: changed && index === 0 ? 2 : index + 1,
          $description: `Primitive scale ${index}`,
        },
      ]),
    ),
  });
}

function semantics(): TokenSourceInput {
  return source("semantic.tokens.json", {
    semantic: Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [
        `alias${index}`,
        {
          $type: "number",
          $value: `{primitive.scale${index}}`,
          $description: `Semantic alias ${index}`,
          ...(index % 10 === 0
            ? {
                $extensions: {
                  "org.token-compiler.contexts": { "theme=dark": index + 10_000 },
                },
              }
            : {}),
        },
      ]),
    ),
  });
}

function components(): TokenSourceInput {
  return source("component.tokens.json", {
    component: Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [
        `value${index}`,
        {
          $type: "number",
          $value: `{semantic.alias${index}}`,
          $description: `Component value ${index}`,
          ...(index % 8 === 0
            ? {
                $extensions: {
                  "org.token-compiler.contexts": { "density=compact": index + 20_000 },
                },
              }
            : {}),
        },
      ]),
    ),
  });
}

/** The only revision difference is primitive.scale0 in the primitive document. */
export function layeredSources(changed = false): readonly TokenSourceInput[] {
  return Object.freeze([primitives(changed), semantics(), components()]);
}
