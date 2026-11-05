const unavailable = (name) => () => {
  throw new Error(`electron.${name} is not available in the authenticated chat recovery E2E.`);
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier !== "electron") return nextResolve(specifier, context);
  const exports = {
    ipcMain: { handle: unavailable("ipcMain.handle"), removeHandler: unavailable("ipcMain.removeHandler") },
    shell: { openExternal: unavailable("shell.openExternal") },
  };
  const source = Object.entries(exports)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join("\n");
  return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
}
