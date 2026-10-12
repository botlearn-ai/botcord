"use client";
/**
 * [INPUT]: DialogShell contract
 * [OUTPUT]: Right-side, full-height dialog using the shared header/body/footer
 * [POS]: UI drawer shell; business state and dashboard portals remain caller-owned
 * [PROTOCOL]: Keep close/busy semantics identical to DialogShell
 */
import DialogShell from "./DialogShell";
import type { DialogShellProps } from "./DialogShell";
export default function DrawerShell(props: Omit<DialogShellProps, "placement">) {
  return <DialogShell {...props} placement="right" />;
}
