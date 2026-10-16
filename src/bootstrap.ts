// Keep Buffer available for @cardano-sdk internals until a browser signing run proves it unnecessary.
import { Buffer } from "buffer";
(globalThis as Record<string, unknown>).Buffer = Buffer;

// Dynamic import ensures Buffer is set before the SDK dependency graph loads.
if (location.pathname === "/midnight" || location.pathname === "/midnight/") {
  await import("./midnight/app");
} else {
  await import("./main");
}
