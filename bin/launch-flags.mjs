/**
 * The exact Chrome command line palmifer builds for a browser it starts itself.
 *
 * Kept as a pure function in its own file for one reason: the flags that matter
 * most are the ones you cannot try out locally. A Linux VPS or container is
 * usually (a) root and (b) shipped with a 64 MB /dev/shm, and Chrome refuses to
 * start in the first case and dies in the second. Those combinations are
 * asserted by tests/private-mode.test.mjs on any platform, so the Linux path is
 * covered by tests even where it cannot be executed.
 *
 * Every input is explicit — platform, uid, /dev/shm size — so the caller decides
 * from the real machine and the function stays deterministic.
 */
export function chromeLaunchFlags({
  profileDir,
  url = "about:blank",
  headless = true,
  platform = process.platform,
  noSandbox = false,
  shmMb = null,
  extra = "",
} = {}) {
  if (!profileDir) throw new Error("chromeLaunchFlags needs a profileDir");

  const flags = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--disable-sync",
    "--disable-background-networking",
  ];

  // Keychain prompts would hang an unattended run: on macOS the mock keychain,
  // elsewhere the plain-text store instead of gnome-keyring/ kwallet.
  if (platform === "darwin") flags.push("--use-mock-keychain", "--password-store=basic");
  else if (platform === "linux") flags.push("--password-store=basic");

  if (platform === "linux") {
    // Chrome refuses to run as root with its sandbox on. That is exactly the
    // state of a fresh VPS or a container running palmifer, so it cannot be
    // left to the user to discover from a stack trace.
    if (noSandbox) flags.push("--no-sandbox");
    // Containers and small instances ship /dev/shm at 64 MB; Chrome crashes on
    // it. Only skip the shm path when it is actually small.
    if (shmMb !== null && shmMb < 512) flags.push("--disable-dev-shm-usage");
  }

  if (headless) flags.push("--headless=new", "--disable-gpu");

  // Escape hatch for anything the tool does not know about (fonts, locale,
  // window size, an outbound proxy).
  const clean = String(extra || "").trim();
  if (clean) flags.push(...clean.split(/\s+/));

  flags.push(url || "about:blank");
  return flags;
}

/** /dev/shm size in MB, or null when it does not exist (macOS, most exotics). */
export function shmSizeMb(statfsSync, path = "/dev/shm") {
  try {
    const s = statfsSync(path);
    return (s.bsize * s.blocks) / 1048576;
  } catch {
    return null;
  }
}

/**
 * Would Chrome's sandbox work here? Root cannot use it, and a kernel with
 * unprivileged user namespaces switched off cannot either — common on VPS
 * images that harden the kernel.
 */
export function sandboxUnavailable({ platform = process.platform, uid, readFileSync, fsPath = "/proc/sys/user/max_user_namespaces" } = {}) {
  if (platform !== "linux") return false;
  if (uid === 0) return true;
  try {
    return Number(String(readFileSync(fsPath, "utf8")).trim()) === 0;
  } catch {
    return false; // no such knob: assume the sandbox is fine
  }
}
