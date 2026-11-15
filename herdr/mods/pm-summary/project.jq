# Projects Claude Code transcript lines (read raw, -R) into small records for
# the Summary view. read.sh feeds it complete lines only.
# Schema-drift guard: a line that is not JSON gives {k:"bad"}, a record type we
# don't know gives {k:"x", t:<type>}; main.js counts both.
def clip($n): if type == "string" and length > $n then .[0:$n] + "…" else . end;
def lines_with($p): [ .[]? | select(type == "string" and startswith($p)) ] | length;
def known: [
  "user", "assistant", "system", "attachment", "summary", "file-history-snapshot",
  "file-history-delta", "permission-mode", "mode", "last-prompt", "ai-title", "custom-title",
  "agent-name", "atis-latch", "api-request", "api-request-blob", "api-request-shape",
  "queue-operation", "session-owner", "tools-used", "pr-link", "progress"
];
def text_of: if type == "string" then . elif type == "array" then [ .[]? | select(.type == "text") | .text ] | join("\n") else "" end;

def patch:
  (.toolUseResult | if type == "object" then . else null end) as $t
  | if $t == null then {}
    elif ($t.structuredPatch | type) == "array" then
      { file: $t.filePath,
        add: ([ $t.structuredPatch[].lines ] | add // [] | lines_with("+")),
        del: ([ $t.structuredPatch[].lines ] | add // [] | lines_with("-")) }
      + (if $t.type == "create" and ($t.structuredPatch | length) == 0
         then { add: ($t.content // "" | split("\n") | length) } else {} end)
    elif $t.agentId then { agent: $t.agentId }
    else {} end;

def proj:
  if .type == "user" then
    . as $r
    | if .isMeta then empty
      elif (.message.content | type) == "string" then
        { k: "u", text: (.message.content | clip(20000)), ts: .timestamp }
      else
        .message.content[]?
        | if .type == "text" then { k: "u", text: (.text | clip(20000)), ts: $r.timestamp }
          elif .type == "tool_result" then
            { k: "tr", id: .tool_use_id, err: (.is_error // false), ts: $r.timestamp }
            + (if .is_error then { msg: (.content | text_of | clip(300)) } else {} end)
            + ($r | patch)
          else empty end
      end
  elif .type == "assistant" then
    . as $r | ($r.message.usage // {}) as $u
    | { k: "m", model: $r.message.model, ts: $r.timestamp, effort: ($r.effort // null), fast: (($u.speed // null) == "fast"),
        ctx: (($u.input_tokens // 0) + ($u.cache_read_input_tokens // 0) + ($u.cache_creation_input_tokens // 0)) },
      ( $r.message.content[]?
        | if .type == "text" then { k: "a", text: (.text | clip(40000)), mid: $r.message.id, ts: $r.timestamp }
          elif .type == "tool_use" then
            { k: "tu", id: .id, name: .name, ts: $r.timestamp,
              file: (.input.file_path // .input.notebook_path // null),
              desc: ((.input.description // .input.command // .input.pattern // null) | clip(200)),
              sub: (.input.subagent_type // null),
              model: (.input.model // null),
              q: (if .name == "AskUserQuestion" then .input.questions else null end),
              plan: (if .name == "ExitPlanMode" then (.input.plan | clip(40000)) else null end),
              planFile: (if .name == "ExitPlanMode" then .input.planFilePath else null end) }
          else empty end )
  elif .type == "system" and .subtype == "turn_duration" then { k: "d", ms: .durationMs, ts: .timestamp }
  elif .type == "system" and .subtype == "compact_boundary" then { k: "c", ts: .timestamp }
  elif .type == "permission-mode" then { k: "pm", mode: .permissionMode }
  elif .type == "ai-title" then { k: "title", text: (.aiTitle | clip(200)) }
  elif .type == "custom-title" then { k: "title", text: (.customTitle | clip(200)) }
  elif (.type | type) == "string" and (.type as $t | known | index($t) | not) then { k: "x", t: .type }
  else empty end;

inputs | (fromjson? // "\u0000bad") | if . == "\u0000bad" then { k: "bad" } elif type == "object" then proj else { k: "bad" } end
