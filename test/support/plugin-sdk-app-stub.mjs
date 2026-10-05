// The plugin SDK's app entry, as a static render needs it: the Pi section asks
// for its reading through `useRpc`, and a render that never runs an effect
// never asks. The stub exists so the component tree can be rendered at all —
// the reading under test is handed to the figures directly.
let callRpc = null;
const rpc = {
  call: async (...args) => {
    if (callRpc) return callRpc(...args);
    throw new Error("no RPC call is made during a static render");
  },
};

export function setRpcCall(call) {
  callRpc = call;
}

export function useRpc() {
  return rpc;
}

export function useRealtime() {}

export function definePluginApp(register) {
  return register;
}
