//! Resident-memory (RSS) reads for the core process — no subprocesses on the
//! platforms where it matters.
//!
//! The dashboard polls this every few seconds, so the implementation matters:
//! the previous version shelled out to `ps` / `tasklist` on every cache miss,
//! which forked a console child (a visible window flash on Windows, where the
//! parent is a GUI-subsystem process) and parsed locale-dependent text.
//!
//! Per-OS strategy:
//! - Windows: `NtQuerySystemInformation(SystemProcessInformation)` — a single
//!   syscall over the kernel's process table, no handle required (so it still
//!   works when sing-box runs elevated for TUN and opening a handle would be
//!   denied), nothing to parse. This is the same table Task Manager shows.
//! - Linux: `/proc/<pid>/status` `VmRSS` — one file read; the kernel reports
//!   kB so there is no page-size arithmetic.
//! - macOS: `ps -o uid=,rss=`. A subprocess here is deliberate: a
//!   setuid-root sing-box's task port cannot be obtained by its
//!   unprivileged parent — verified experimentally: `proc_pidinfo` (both
//!   `PROC_PIDTASKINFO` for RSS and `PROC_PIDTBSDINFO` for uid) returns
//!   EPERM for a target owned by a different user, no matter which flavor.
//!   `ps` itself is setuid-root with the private
//!   `com.apple.system-task-ports.read` entitlement (`codesign -d
//!   --entitlements -`), which is what actually lets it read across users —
//!   an entitlement third-party binaries cannot obtain. So the subprocess
//!   isn't a shortcut we chose over a cleaner syscall; it's the only reader
//!   on this OS that isn't privilege-gated. macOS also has no
//!   console-window problem to hide, and both fields ride the same process
//!   snapshot, so reading uid alongside rss here is free — no second fork.

/// RSS and root-ness of `pid`, in one platform read where the OS makes that
/// free (macOS: one `ps` call already open for RSS). `None` fields mean that
/// piece of info could not be determined; a wholly `None` return means the
/// process itself could not be read (gone, or the OS surface denied us).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProcessMemInfo {
    pub rss_bytes: Option<u64>,
    /// True when the process' (effective) user is root/admin — i.e. it is
    /// running with elevated privileges (macOS: setuid-root sing-box under
    /// TUN). `None` where this OS's reader doesn't determine it.
    pub is_root: Option<bool>,
}

/// Resident set size and root-ness of `pid` in one platform read (see
/// `ProcessMemInfo`). One call for both fields — on macOS they ride the
/// same `ps` snapshot, so a caller needing only one still gets it for the
/// cost of a single subprocess.
pub fn read_process_mem_info(pid: u32) -> ProcessMemInfo {
    read_info(pid)
}

/// Whether `pid` is currently running as root/admin (elevated). `None` when
/// this platform's reader doesn't surface that (or the process is gone).
/// macOS-only by caller (the `self_process_is_not_root` test); other
/// platforms' readers never set `is_root`, so there is nothing to wrap.
#[cfg(all(test, target_os = "macos"))]
pub fn read_process_is_root(pid: u32) -> Option<bool> {
    read_info(pid).is_root
}

#[cfg(target_os = "windows")]
fn read_info(pid: u32) -> ProcessMemInfo {
    use windows::Wdk::System::SystemInformation::{
        NtQuerySystemInformation, SystemProcessInformation,
    };
    use windows::Win32::System::WindowsProgramming::SYSTEM_PROCESS_INFORMATION;

    // The table for a few hundred processes is ~100–300 KB; start generous
    // and grow when the kernel reports STATUS_INFO_LENGTH_MISMATCH.
    let mut len = 256 * 1024usize;
    for _ in 0..4 {
        // u64 elements give the buffer the pointer alignment the NT structs
        // require (a Vec<u8> would only guarantee byte alignment).
        let mut buf = vec![0u64; len / 8];
        let mut needed = 0u32;
        let status = unsafe {
            NtQuerySystemInformation(
                SystemProcessInformation,
                buf.as_mut_ptr().cast(),
                len as u32,
                &mut needed,
            )
        };
        // NTSTATUS success is a non-negative severity (>= 0).
        if status.0 >= 0 {
            // Entries sit back-to-back; NextEntryOffset chains them and a
            // zero offset marks the last one. Offsets are pointer multiples,
            // so walking with cast pointers stays well-aligned. Walk the
            // buffer as raw bytes — `add` is in units of the pointee.
            let base = buf.as_ptr().cast::<u8>();
            let mut offset = 0usize;
            loop {
                let entry = unsafe { &*base.add(offset).cast::<SYSTEM_PROCESS_INFORMATION>() };
                if entry.UniqueProcessId.0 as u32 == pid {
                    return ProcessMemInfo {
                        rss_bytes: Some(entry.WorkingSetSize as u64),
                        // SYSTEM_PROCESS_INFORMATION carries no owner-token
                        // info without opening a handle (which an elevated
                        // target can deny to its unprivileged parent) — the
                        // dashboard's ROOT badge relies on the elevated-PID
                        // bookkeeping in `core::manager` on this platform
                        // instead, which is exact here (Windows elevation is
                        // always this app's own `run_elevated` call, not a
                        // filesystem-persisted bit like macOS setuid).
                        is_root: None,
                    };
                }
                let next = entry.NextEntryOffset as usize;
                if next == 0 {
                    return ProcessMemInfo::default();
                }
                offset += next;
            }
        }
        // Buffer too small (or the table grew mid-query): retry with the size
        // the kernel asked for plus slack.
        let want = needed as usize;
        if want <= len {
            return ProcessMemInfo::default(); // unexpected failure status, growing won't help
        }
        len = want + 64 * 1024;
    }
    ProcessMemInfo::default()
}

#[cfg(target_os = "linux")]
fn read_info(pid: u32) -> ProcessMemInfo {
    let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) else {
        return ProcessMemInfo::default();
    };
    let mut info = ProcessMemInfo::default();
    for line in status.lines() {
        // "VmRSS:\t  12345 kB" — kernel-provided, locale-independent, always kB.
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            if let Ok(kb) = rest.trim_end_matches("kB").trim().parse::<u64>() {
                info.rss_bytes = Some(kb * 1024);
            }
        }
        // No Linux elevation path exists in this app today (TUN there needs
        // the whole process to run privileged, not a setuid sing-box), so we
        // don't bother parsing "Uid:\t<real>\t<effective>..." for a badge
        // that would never light up. Revisit if that changes.
    }
    info
}

#[cfg(target_os = "macos")]
fn read_info(pid: u32) -> ProcessMemInfo {
    // Subprocess on purpose — see the module docs for the privilege story.
    // One call for both fields: they ride the same process snapshot, so
    // reading uid alongside rss is free — no second fork.
    let out = std::process::Command::new("ps")
        .args(["-o", "uid=,rss=", "-p", &pid.to_string()])
        .output();
    let Ok(out) = out else {
        return ProcessMemInfo::default();
    };
    if !out.status.success() {
        return ProcessMemInfo::default();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut fields = text.split_whitespace();
    let uid = fields.next().and_then(|s| s.parse::<u32>().ok());
    let rss_kb = fields.next().and_then(|s| s.parse::<u64>().ok());
    ProcessMemInfo {
        rss_bytes: rss_kb.map(|kb| kb * 1024),
        is_root: uid.map(|u| u == 0),
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn read_info(_pid: u32) -> ProcessMemInfo {
    ProcessMemInfo::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_own_process_rss() {
        let rss = read_process_mem_info(std::process::id()).rss_bytes;
        assert!(
            rss.unwrap_or(0) > 0,
            "own RSS should be readable, got {rss:?}"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn missing_pid_reports_none() {
        // Windows PIDs are multiples of 4, so u32::MAX can never be live.
        assert_eq!(read_process_mem_info(u32::MAX).rss_bytes, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn self_process_is_not_root() {
        // The test runner is never root in CI/dev; this pins the uid=0
        // parsing path without needing an actual root process to test
        // against (that would need sudo, which we won't shell out to here).
        assert_eq!(read_process_is_root(std::process::id()), Some(false));
    }
}
