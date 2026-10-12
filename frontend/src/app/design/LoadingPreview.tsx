"use client";

/**
 * [INPUT]: BotCordLoader / BotCordLoadingScreen and the native dialog API
 * [OUTPUT]: Inline loading samples and an escapable full-page loading preview
 * [POS]: /design loading gallery; the full-page preview reuses the root loading boundary component
 * [PROTOCOL]: Keep examples aligned with components/ui/BotCordLoader
 */
import { useRef } from "react";
import Button from "@/components/ui/Button";
import { BotCordLoader, BotCordLoadingScreen } from "@/components/ui/BotCordLoader";

export default function LoadingPreview() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-8 rounded-xl border border-border bg-surface p-8">
        <BotCordLoader size="xs" showLabel={false} label="正在加载" />
        <BotCordLoader size="sm" showLabel={false} label="正在加载" />
        <BotCordLoader size="md" label="正在加载 BotCord" />
        <Button onClick={() => dialogRef.current?.showModal()}>预览全页面加载</Button>
      </div>
      <dialog
        ref={dialogRef}
        aria-label="全页面加载预览"
        className="m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-bg p-6 text-text-primary"
      >
        <div className="absolute right-6 top-6">
          <Button autoFocus onClick={() => dialogRef.current?.close()}>关闭预览</Button>
        </div>
        <div className="flex min-h-full items-center justify-center">
          <BotCordLoadingScreen label="正在加载 BotCord" />
        </div>
      </dialog>
    </>
  );
}
