// The epubveri and epubsana wasm packages are built for bundlers that import .wasm files as modules, which Bun
// does not. wasm.ts loads their two halves itself; these declarations type them.

declare module "@veripublica/epubveri-wasm/epubveri_bg.wasm" {
    /** Path of the file, embedded into the executable by `bun build --compile` */
    const path: string;
    export default path;
}

declare module "@veripublica/epubveri-wasm/epubveri_bg.js" {
    export { validate, version } from "@veripublica/epubveri-wasm";
    export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}

declare module "@veripublica/epubsana-wasm/epubsana_wasm_bg.wasm" {
    const path: string;
    export default path;
}

declare module "@veripublica/epubsana-wasm/epubsana_wasm_bg.js" {
    export { Session, version } from "@veripublica/epubsana-wasm";
    export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
