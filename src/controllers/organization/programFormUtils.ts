import crypto from "crypto";

export const FORM_FIELD_TYPES = ["short_text", "long_text", "url", "number", "date", "select", "checkbox", "file"] as const;
export type FormFieldType = typeof FORM_FIELD_TYPES[number];
export interface ProgramFormField {
  id: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  helpText?: string;
  options?: string[];
}

export function normalizeFields(input: unknown): ProgramFormField[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > 30) return null;
  const fields: ProgramFormField[] = [];
  const used = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 120) : "";
    const type = raw.type;
    if (!label || !FORM_FIELD_TYPES.includes(type as FormFieldType)) return null;
    let id = typeof raw.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.id)
      ? raw.id
      : crypto.randomUUID();
    if (used.has(id)) id = crypto.randomUUID();
    used.add(id);
    const field: ProgramFormField = {
      id,
      label,
      type: type as FormFieldType,
      required: raw.required === true,
    };
    if (typeof raw.helpText === "string" && raw.helpText.trim()) field.helpText = raw.helpText.trim().slice(0, 500);
    if (field.type === "select") {
      const options = Array.isArray(raw.options)
        ? raw.options.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 100)).filter(Boolean).slice(0, 30)
        : [];
      if (!options.length) return null;
      field.options = [...new Set(options)];
    }
    fields.push(field);
  }
  return fields;
}

export function validateAnswers(fields: ProgramFormField[], raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field.id];
    const missing = value == null || value === "" || (Array.isArray(value) && !value.length);
    if (field.required && missing) return null;
    if (missing) continue;
    switch (field.type) {
      case "short_text":
        if (typeof value !== "string" || value.length > 1000) return null;
        output[field.id] = value.trim();
        break;
      case "long_text":
        if (typeof value !== "string" || value.length > 10000) return null;
        output[field.id] = value.trim();
        break;
      case "url": {
        if (typeof value !== "string" || value.length > 2048) return null;
        try {
          const url = new URL(value);
          if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        } catch { return null; }
        output[field.id] = value;
        break;
      }
      case "number": {
        const number = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(number)) return null;
        output[field.id] = number;
        break;
      }
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return null;
        output[field.id] = value;
        break;
      case "select":
        if (typeof value !== "string" || !field.options?.includes(value)) return null;
        output[field.id] = value;
        break;
      case "checkbox":
        if (typeof value !== "boolean") return null;
        output[field.id] = value;
        break;
      case "file":
        if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) return null;
        output[field.id] = value;
        break;
    }
  }
  return output;
}
