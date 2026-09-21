import { describe, expect, it } from "vitest";
import { validateGitSource } from "../src/security/gitSource.mjs";

describe("validateGitSource", () => {
  it("allows a public HTTPS URL", async () => {
    await expect(
      validateGitSource({ url: "https://github.com/example/project.git" }),
    ).resolves.toBeUndefined();
  });

  it("rejects HTTP (non-HTTPS)", async () => {
    await expect(
      validateGitSource({ url: "http://github.com/example/project.git" }),
    ).rejects.toThrow(/HTTPS/);
  });

  it("rejects a local filesystem path unless allowLocal is set", async () => {
    await expect(validateGitSource({ url: "/home/jason/Clocker" })).rejects.toThrow();

    await expect(
      validateGitSource({ url: "/home/jason/Clocker" }, { allowLocal: true }),
    ).resolves.toBeUndefined();
  });

  it("rejects localhost", async () => {
    await expect(
      validateGitSource({ url: "https://localhost/x.git" }),
    ).rejects.toThrow(/localhost/);
  });

  it("rejects a private IP literal", async () => {
    await expect(
      validateGitSource({ url: "https://10.1.30.65/x.git" }),
    ).rejects.toThrow(/private/);
  });

  it("rejects a loopback IP literal", async () => {
    await expect(
      validateGitSource({ url: "https://127.0.0.1/x.git" }),
    ).rejects.toThrow(/private/);
  });

  it("rejects a link-local IP literal", async () => {
    await expect(
      validateGitSource({ url: "https://169.254.1.1/x.git" }),
    ).rejects.toThrow(/private/);
  });

  it("allows a public IP literal", async () => {
    await expect(
      validateGitSource({ url: "https://140.82.112.3/x.git" }),
    ).resolves.toBeUndefined();
  });
});
