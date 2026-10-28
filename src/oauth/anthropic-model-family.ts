/** Pure family identity shared by existing hard policy and loaded-only advisory evidence. */
// Haly: Haiku is a family too, so per-family quota windows and cooldowns cover it.
export type AnthropicModelFamily = "Fable" | "Opus" | "Sonnet" | "Haiku";
/** Return the Anthropic model family (Fable, Opus, Sonnet or Haiku) named by a model id, or undefined for other models. */
export function anthropicModelFamily(model?: string): AnthropicModelFamily | undefined {
  return /(?:^|[/])claude-fable-5(?:-|$)/i.test(model ?? "") ? "Fable"
    : /(?:^|[/])claude-opus-/i.test(model ?? "") ? "Opus"
      : /(?:^|[/])claude-sonnet-/i.test(model ?? "") ? "Sonnet"
        : /(?:^|[/])claude-haiku-/i.test(model ?? "") ? "Haiku" : undefined;
}
