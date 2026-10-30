/**
 * Instantiate a wasm-bindgen package built for bundlers. Those import their .wasm as a module, which Bun
 * does not support, so the module is compiled here with the package's JS glue as its imports.
 */
export async function loadWasm(wasmPath: string, bindings: { __wbg_set_wasm(exports: WebAssembly.Exports): void }): Promise<void> {
    const module = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
    const imports = Object.fromEntries(WebAssembly.Module.imports(module).map((imp) => [imp.module, bindings]));
    const instance = await WebAssembly.instantiate(module, imports);
    bindings.__wbg_set_wasm(instance.exports);
    (instance.exports.__wbindgen_start as (() => void) | undefined)?.();
}
