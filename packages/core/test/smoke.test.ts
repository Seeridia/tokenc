import { describe, expect, it } from "vite-plus/test";

import { VERSION } from "../src/index.js";

describe("core package", () => {
  it("exports its version", () => expect(VERSION).toBe("0.1.0"));
});
