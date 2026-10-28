// abi.test.mjs — which processor types (ABIs) a build compiles native code for
// (src/worker/abi.mjs). Proves the defaults (debug: arm64-v8a only; release:
// unrestricted), that a release build honors an explicit ANDROID_ABI (2.7.0 —
// how a small release APK is made), and that anything other than real ABI
// names is refused, since the value is placed in the build's shell command
// (a crafted value must never inject shell syntax).
import { describe, expect, test } from "vitest";
import { resolveAbi, KNOWN_ABIS } from "../src/worker/abi.mjs";

describe("resolveAbi", () => {
  test("debug defaults to arm64-v8a only", () => {
    expect(resolveAbi("debug", undefined)).toEqual({ abi: "arm64-v8a", restrict: true });
  });

  test("release defaults to every ABI (no restriction)", () => {
    expect(resolveAbi("release", undefined)).toEqual({ abi: null, restrict: false });
    expect(resolveAbi("release", "")).toEqual({ abi: null, restrict: false });
  });

  test("an explicit ABI list is honored for release and debug alike", () => {
    expect(resolveAbi("release", "arm64-v8a")).toEqual({ abi: "arm64-v8a", restrict: true });
    expect(resolveAbi("debug", " arm64-v8a , x86_64 ")).toEqual({ abi: "arm64-v8a,x86_64", restrict: true });
    expect(resolveAbi("release", KNOWN_ABIS.join(","))).toEqual({ abi: KNOWN_ABIS.join(","), restrict: true });
  });

  test("anything but real ABI names is refused (no shell injection)", () => {
    for (const bad of ["arm64", "arm64-v8a; rm -rf /", "$(id)", "x86_64 && curl evil", "arm64-v8a,", "`whoami`"]) {
      expect(() => resolveAbi("release", bad)).toThrow(/ANDROID_ABI/);
    }
  });
});
