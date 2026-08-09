const copyButton = document.querySelector("[data-copy-target]");
const installCommand = document.getElementById("install-command");
const installOptions = document.querySelectorAll("[data-install-command]");

for (const option of installOptions) {
  option.addEventListener("click", () => {
    const command = option.getAttribute("data-install-command");
    if (!command || !installCommand) return;

    installCommand.textContent = command;
    for (const candidate of installOptions) {
      const isActive = candidate === option;
      candidate.classList.toggle("active", isActive);
      candidate.setAttribute("aria-pressed", String(isActive));
    }
  });
}

copyButton?.addEventListener("click", async () => {
  const targetId = copyButton.getAttribute("data-copy-target");
  const target = targetId ? document.getElementById(targetId) : null;
  const command = target?.textContent?.trim();

  if (!command) return;

  try {
    await navigator.clipboard.writeText(command);
    copyButton.textContent = "已复制";
  } catch {
    copyButton.textContent = "请手动复制";
  }

  window.setTimeout(() => {
    copyButton.textContent = "复制";
  }, 1800);
});

const year = document.querySelector("[data-current-year]");
if (year) year.textContent = String(new Date().getFullYear());
