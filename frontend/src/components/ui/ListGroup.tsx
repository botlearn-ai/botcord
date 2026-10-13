/**
 * [INPUT]: 原生 ul / li 属性；依赖 VI 语义色（border-border、bg-surface）与 clsx
 * [OUTPUT]: 对外提供 ListGroup（描边圆角列表，默认带分隔线）与 ListGroupItem（统一行内边距和对齐）
 * [POS]: ui 内容原语；申请列表、可添加成员等卡片内的成组行统一从这里出。可点击整行用 Button variant="row"
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；保留 ul / li 列表语义
 */

import type { HTMLAttributes, LiHTMLAttributes } from "react";
import { clsx } from "clsx";

export interface ListGroupProps extends HTMLAttributes<HTMLUListElement> {
  divided?: boolean;
}

export default function ListGroup({ divided = true, className, ...rest }: ListGroupProps) {
  return (
    <ul
      {...rest}
      className={clsx("overflow-hidden rounded-xl border border-border bg-surface", divided && "divide-y divide-border", className)}
    />
  );
}

export interface ListGroupItemProps extends LiHTMLAttributes<HTMLLIElement> {
  align?: "center" | "start";
}

export function ListGroupItem({ align = "center", className, ...rest }: ListGroupItemProps) {
  return <li {...rest} className={clsx("flex gap-3 px-3 py-2.5 text-sm", align === "start" ? "items-start" : "items-center", className)} />;
}
