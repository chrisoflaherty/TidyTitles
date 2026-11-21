/** The naming preset picker and the placeholder reference of the Templates tab. */

import { useId } from "react";
import type { NamingPreset, TemplateFieldDoc } from "@tidytitles/core";
import type { TemplateSet } from "../../../shared/ipc";
import { CUSTOM_PRESET_ID, presetFor } from "../presets";

export function PresetPicker({
  presets,
  templates,
  onChoose,
}: {
  presets: readonly NamingPreset[];
  templates: TemplateSet;
  onChoose: (templates: TemplateSet) => void;
}) {
  const id = useId();
  const current = presetFor(templates, presets);
  return (
    <div className="form-row preset-row">
      <label htmlFor={id}>Naming preset</label>
      <select
        id={id}
        value={current?.id ?? CUSTOM_PRESET_ID}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          const preset = presets.find((p) => p.id === e.target.value);
          if (preset) onChoose({ ...preset.templates });
        }}
        data-testid="naming-preset"
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value={CUSTOM_PRESET_ID} disabled>
          Custom
        </option>
      </select>
      <span id={`${id}-hint`} className="form-hint block" data-testid="naming-preset-hint">
        {current
          ? current.description
          : "Custom: the templates below match no preset. Choosing a preset replaces all three."}
      </span>
    </div>
  );
}

export function PlaceholderTable({
  docs,
  groupLabels,
}: {
  docs: readonly TemplateFieldDoc[];
  groupLabels: Record<string, string>;
}) {
  const groups = [...new Set(docs.map((d) => d.group))];
  return (
    <table className="placeholder-table" data-testid="placeholder-table">
      {groups.map((group) => (
        <tbody key={group}>
          <tr>
            <th colSpan={3} scope="colgroup">
              {groupLabels[group] ?? group}
            </th>
          </tr>
          {docs
            .filter((d) => d.group === group)
            .map((d) => (
              <tr key={d.field}>
                <td className="mono">{`{${d.field}}`}</td>
                <td>{d.description}</td>
                <td className="mono muted">{d.example}</td>
              </tr>
            ))}
        </tbody>
      ))}
    </table>
  );
}
