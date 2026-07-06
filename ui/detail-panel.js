import { AlertTriangle, CheckCircle2, Clock3, CircleDot, FileText, Layers3, TimerReset, XCircle } from "./icons.js";
import { compactText, formatDuration, formatDate, outputText } from "./state.js";
import { workerModelSettings } from "./model-settings.js";

const React = window.React;
const h = React.createElement;

function StatusIcon({ status }) {
  const props = { size: 18, strokeWidth: 2.25 };
  if (status === "completed") return h(CheckCircle2, props);
  if (status === "failed") return h(XCircle, props);
  if (status === "cancelled") return h(AlertTriangle, props);
  if (status === "running") return h(TimerReset, props);
  return h(Clock3, props);
}

function Metric({ icon, label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return h("div", { className: "metric" }, h("span", { className: "metric-icon" }, icon), h("span", null, label), h("strong", null, value));
}

function EventRow({ event }) {
  return h(
    "li",
    { className: "event-row" },
    h("time", null, formatDate(event.at)),
    h("span", { className: "event-type" }, event.type || "event"),
    h("span", { className: "event-message" }, event.message || event.label || "")
  );
}

export function DetailPanel({ selected, events, record }) {
  if (!selected) {
    return h(
      "aside",
      { className: "details details-empty" },
      h("div", { className: "details-empty-icon" }, h(CircleDot, { size: 28 })),
      h("h2", null, "Workflow"),
      h("p", null, record && record.task ? record.task : record ? record.id : "Waiting for a workflow record.")
    );
  }

  const selectedKeys = new Set([selected.id, selected.step_id, selected.label, selected.title].filter(Boolean));
  const relatedEvents = events
    .filter((event) => selectedKeys.has(event.id) || selectedKeys.has(event.step_id) || selectedKeys.has(event.label))
    .slice(-8)
    .reverse();
  const text = outputText(selected);
  const prompt = selected.spec && selected.spec.prompt ? compactText(selected.spec.prompt, 700) : "";
  const usage = selected.usage && Number.isFinite(selected.usage.total_tokens) ? selected.usage.total_tokens : null;
  const settings = workerModelSettings(selected, record);
  const isControl = selected.control === true;

  return h(
    "aside",
    { className: "details" },
    h(
      "div",
      { className: `details-heading status-${selected.status}` },
      h("div", { className: "details-status" }, h(StatusIcon, { status: selected.status })),
      h("div", null, h("h2", null, selected.title), h("p", null, selected.last_message || selected.status))
    ),
    h(
      "div",
      { className: "metric-grid" },
      h(Metric, { icon: h(Layers3, { size: 15 }), label: "Type", value: selected.kind }),
      h(Metric, { icon: h(FileText, { size: 15 }), label: "Phase", value: selected.phase }),
      isControl ? h(Metric, { icon: h(CircleDot, { size: 15 }), label: "Kind", value: selected.wait_kind }) : h(Metric, { icon: h(CircleDot, { size: 15 }), label: "Model", value: settings.model }),
      isControl ? h(Metric, { icon: h(CircleDot, { size: 15 }), label: "Items", value: selected.item_count }) : h(Metric, { icon: h(CircleDot, { size: 15 }), label: "Reasoning", value: settings.reasoning }),
      h(Metric, { icon: h(TimerReset, { size: 15 }), label: "Duration", value: formatDuration(selected.duration_ms) }),
      h(Metric, { icon: h(CircleDot, { size: 15 }), label: "Tokens", value: usage === null ? "" : usage.toLocaleString() })
    ),
    selected.error
      ? h("section", { className: "detail-section danger" }, h("h3", null, "Error"), h("pre", null, selected.error))
      : null,
    text ? h("section", { className: "detail-section" }, h("h3", null, "Output"), h("pre", null, text)) : null,
    prompt ? h("section", { className: "detail-section" }, h("h3", null, "Prompt"), h("pre", null, prompt)) : null,
    h(
      "section",
      { className: "detail-section" },
      h("h3", null, "Events"),
      relatedEvents.length
        ? h("ul", { className: "event-list" }, relatedEvents.map((event, index) => h(EventRow, { event, key: `${event.at || ""}-${index}` })))
        : h("p", { className: "muted" }, "No worker-specific events yet.")
    )
  );
}
