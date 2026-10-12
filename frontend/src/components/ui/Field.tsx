/**
 * [INPUT]: 依赖 VI 颜色语义类（text-text-secondary、text-danger 与 VI 字体规格）与 clsx
 * [OUTPUT]: 对外提供 Field：标签 + 控件 + 提示 / 错误（role="alert"）的表单行；单个控件元素会自动补 id、aria-describedby、aria-invalid
 * [POS]: ui 表单原语（批次 2）；与 Input / Textarea / Checkbox 组合使用，不再手写 label + 错误文案
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；样式规则以 VI.md §3、§4 为准
 */
"use client";

import { cloneElement, isValidElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { clsx } from "clsx";

export interface FieldProps {
  label: ReactNode;
  /** id of the control; generated and injected into a single child element when omitted. */
  htmlFor?: string;
  hint?: ReactNode;
  /** Replaces the hint and is announced (role="alert"). */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" };

export default function Field({ label, htmlFor, hint, error, required = false, className, children }: FieldProps) {
  const baseId = useId();
  const hasError = error != null && error !== false && error !== "";
  const hasHint = !hasError && hint != null && hint !== false && hint !== "";
  const messageId = `${baseId}-message`;

  let controlId = htmlFor;
  let control = children;
  if (isValidElement<ControlProps>(children)) {
    const props = (children as ReactElement<ControlProps>).props;
    controlId = htmlFor ?? props.id ?? `${baseId}-control`;
    const describedBy = [props["aria-describedby"], hasError || hasHint ? messageId : null].filter(Boolean).join(" ");
    control = cloneElement(children as ReactElement<ControlProps>, {
      id: controlId,
      "aria-describedby": describedBy || undefined,
      ...(hasError ? { "aria-invalid": true } : {}),
    });
  }

  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={controlId} className="type-caption text-text-secondary">
        {label}
        {required ? <span aria-hidden className="ml-0.5 text-danger">*</span> : null}
      </label>
      {control}
      {hasError ? (
        <p id={messageId} role="alert" className="type-body-sm text-danger">{error}</p>
      ) : hasHint ? (
        <p id={messageId} className="type-body-sm text-text-secondary">{hint}</p>
      ) : null}
    </div>
  );
}
