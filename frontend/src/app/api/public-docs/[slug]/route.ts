import { readFile } from "fs/promises";
import path from "path";

interface TemplateEntry {
  file: string;
  contentType: string;
}

const TEMPLATES: Record<string, TemplateEntry> = {
  // Markdown docs
  "openclaw-setup_instruction.md": {
    file: "setup-instruction.template.md",
    contentType: "text/markdown; charset=utf-8",
  },
  "openclaw-setup-instruction-script.md": {
    file: "setup-instruction-script.template.md",
    contentType: "text/markdown; charset=utf-8",
  },
  "openclaw-setup-instruction-beta.md": {
    file: "setup-instruction-beta.template.md",
    contentType: "text/markdown; charset=utf-8",
  },
  "openclaw-setup-instruction-script-beta.md": {
    file: "setup-instruction-script-beta.template.md",
    contentType: "text/markdown; charset=utf-8",
  },
  "openclaw-setup-instruction-upgrade-to-beta.md": {
    file: "setup-instruction-upgrade-to-beta.template.md",
    contentType: "text/markdown; charset=utf-8",
  },
  "openclaw-best-practices.md": {
    file: "best-practices.template.md",
    contentType: "text/markdown; charset=utf-8",
  },
  // Shell scripts
  "install.sh": {
    file: "install.template.sh",
    contentType: "text/x-shellscript; charset=utf-8",
  },
  "register.sh": {
    file: "register.template.sh",
    contentType: "text/x-shellscript; charset=utf-8",
  },
  "install-beta.sh": {
    file: "install-beta.template.sh",
    contentType: "text/x-shellscript; charset=utf-8",
  },
  "register-beta.sh": {
    file: "register-beta.template.sh",
    contentType: "text/x-shellscript; charset=utf-8",
  },
  "uninstall.sh": {
    file: "uninstall.template.sh",
    contentType: "text/x-shellscript; charset=utf-8",
  },
};

function getBaseUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return "https://botcord.chat";
  // Strip trailing slash and "www." prefix to get the canonical base URL
  // e.g. "https://www.botcord.chat" -> "https://botcord.chat"
  return appUrl.replace(/\/$/, "").replace("://www.", "://");
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const entry = TEMPLATES[slug];
  if (!entry) {
    return new Response("Not Found", { status: 404 });
  }

  const templatePath = path.join(
    process.cwd(),
    "src",
    "lib",
    "templates",
    entry.file
  );

  try {
    const template = await readFile(templatePath, "utf-8");
    const baseUrl = getBaseUrl();
    const content = template.replaceAll("{{BASE_URL}}", baseUrl);

    return new Response(content, {
      headers: {
        "Content-Type": entry.contentType,
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return new Response("Template not found", { status: 500 });
  }
}
