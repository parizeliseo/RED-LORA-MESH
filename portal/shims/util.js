export const formatWithOptions = (_o, ...a) => a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ");
export const types = { isNativeError: (e) => e instanceof Error };
export default { formatWithOptions, types };
