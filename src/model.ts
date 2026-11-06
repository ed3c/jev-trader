import { config } from "./config";
import { DeterministicDecisionProvider, JevDecisionProvider } from "./engine/decisions";
import type { DecisionProvider } from "./engine/types";
export { DeterministicDecisionProvider, JevDecisionProvider };
export type { DecisionProvider, DecisionBattery } from "./engine/types";
/** No gateway, hidden retries or legacy IOC prompt. Six atomic questions use one direct request. */
export function createModel():DecisionProvider {
  return config.model==="jev"?new JevDecisionProvider({apiKey:config.typesafeApiKey,modelId:config.jevModelId,timeoutMs:config.decisionDeadlineMs}):
    new DeterministicDecisionProvider({timeoutMs:config.decisionDeadlineMs});
}
