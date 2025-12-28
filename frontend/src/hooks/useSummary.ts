/**
 * useSummary hook - Bridge to global SummaryContext
 * For backward compatibility, re-exports types and provides the same interface
 */

export type {
  SummaryStatus,
  GenerationConfig,
  LogEntry,
} from "./SummaryContext";
export { useSummaryContext as useSummary } from "./SummaryContext";
