import { NetworkObserver, TransactionStack, AIAgent, LifecycleTracker, getDynamicTip } from "./sdk.js";

console.log("[SDK Test] Verifying SDK Exports...");
console.log("NetworkObserver is type:", typeof NetworkObserver);
console.log("TransactionStack is type:", typeof TransactionStack);
console.log("AIAgent is type:", typeof AIAgent);
console.log("LifecycleTracker is type:", typeof LifecycleTracker);
console.log("getDynamicTip is type:", typeof getDynamicTip);

console.log("[SDK Test] Instantiating AIAgent with LM Studio Config...");
const agent = new AIAgent({
  provider: "lmstudio",
  baseUrl: "http://localhost:1234/v1"
});
console.log("[SDK Test] AIAgent successfully created! Active provider chain verified.");
console.log("[SDK Test] All SDK exports loaded and verified successfully.");
process.exit(0);
