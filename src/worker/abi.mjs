// abi.mjs — which Android processor types (ABIs) a build's native code is
// compiled for. Used by the worker (src/worker/index.mjs) to build Gradle's
// -PreactNativeArchitectures flag.
//
// - Debug builds: always restricted; `arm64-v8a` (essentially every real phone)
//   unless build.env.ANDROID_ABI says otherwise. A debug build carries
//   unstripped native libraries per ABI, which is what makes an all-ABI debug
//   APK huge (~230 MB).
// - Release builds (2.7.0): every ABI by default (as before — an AAB for Google
//   Play lets Play deliver per device), or exactly what ANDROID_ABI asks for (a
//   release APK installed directly on known hardware: ~45 MB for arm64-v8a).
//
// Security: the value ends up inside the build's shell command, so only the
// four real ABI names are accepted (comma-separated) — anything else is
// refused before it gets near a shell.

export const KNOWN_ABIS = ["armeabi-v7a", "arm64-v8a", "x86", "x86_64"];

// variant: "debug" | "release". requested: build.env.ANDROID_ABI (may be undefined).
// → { abi: "arm64-v8a" | "a,b" | null, restrict: boolean }. Throws on a bad value.
export function resolveAbi(variant, requested) {
  if (requested === undefined || requested === null || requested === "") {
    return variant === "debug" ? { abi: "arm64-v8a", restrict: true } : { abi: null, restrict: false };
  }
  const parts = String(requested).split(",").map((v) => v.trim());
  if (parts.some((v) => !KNOWN_ABIS.includes(v))) {
    throw new Error(`build.env.ANDROID_ABI must be one or more of ${KNOWN_ABIS.join(", ")}, comma-separated.`);
  }
  return { abi: [...new Set(parts)].join(","), restrict: true };
}
