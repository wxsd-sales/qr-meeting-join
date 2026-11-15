import { describe, expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLES,
  buildWebappConfigJs,
  crc32,
  makeZip,
} from "../../wizard/bundle.js";

describe("bundle", () => {
  test("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("makeZip produces an archive that `unzip` accepts", () => {
    const enc = new TextEncoder();
    const zip = makeZip([
      { name: "a.txt", data: enc.encode("hello") },
      { name: "dir/b.txt", data: enc.encode("world") },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "zip-"));
    const file = join(dir, "t.zip");
    writeFileSync(file, zip);
    expect(execFileSync("unzip", ["-p", file, "dir/b.txt"]).toString()).toBe(
      "world",
    );
    expect(() => execFileSync("unzip", ["-tq", file])).not.toThrow();
  });

  test("every bundled file exists on disk", () => {
    for (const spec of Object.values(BUNDLES)) {
      for (const name of spec.files) {
        expect(() => readFileSync(join("..", "..", spec.dir, name), "utf8"))
          .toBeDefined;
        expect(
          readFileSync(new URL(`../../${spec.dir}/${name}`, import.meta.url))
            .length,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("buildWebappConfigJs embeds values safely", () => {
    const js = buildWebappConfigJs({
      clientId: 'a"b',
      allowedEndpointHosts: ["hooks.example.com"],
    });
    expect(js).toContain('"clientId": "a\\"b"');
    expect(js).toContain("hooks.example.com");
  });
});
