//! A Windows job object that holds the packaged sidecar's processes (sidecar.rs).
//!
//! The sidecar (a PyInstaller onedir launcher running Python in its own process) runs CLIs such as
//! claude and codex, and killing the sidecar alone (what `Child::kill` does) would leave them running.
//! A process started by a process in a job belongs to the job as well, so the job holds the sidecar and
//! the CLIs it runs. It ends them all when its last handle closes: when the app exits, however it exits
//! (a crash, 「タスクの終了」).
//!
//! The job lets its processes start one outside it (JOB_OBJECT_LIMIT_BREAKAWAY_OK, when asked with
//! CREATE_BREAKAWAY_FROM_JOB): the sign-in console of a CLI, and the browser it opens, may outlive the app.

#[cfg(windows)]
pub use windows::Job;

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// The exit code of the processes `terminate` ends.
    const KILLED: u32 = 1;

    /// A job whose processes end when it is dropped (and when the app exits, which closes its handle).
    pub struct Job(OwnedHandle);

    fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: a handle just returned by the system, owned by no one else.
            Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
        }
    }

    fn checked(ok: BOOL) -> io::Result<()> {
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn raw(handle: &OwnedHandle) -> HANDLE {
        handle.as_raw_handle() as HANDLE
    }

    impl Job {
        /// A new job holding process `pid`, which must not have started processes of its own yet:
        /// those are not moved into the job. The sidecar starts processes only when asked through its
        /// API (seconds later at the earliest), and the job holds it within milliseconds of its start.
        pub fn contain(pid: u32) -> io::Result<Job> {
            // SAFETY: no security attributes and no name.
            let job = Job(owned(unsafe {
                CreateJobObjectW(std::ptr::null(), std::ptr::null())
            })?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            // SAFETY: the structure the information class names, with its size.
            checked(unsafe {
                SetInformationJobObject(
                    raw(&job.0),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            })?;
            // SAFETY: plain calls on handles owned here.
            let process =
                owned(unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) })?;
            checked(unsafe { AssignProcessToJobObject(raw(&job.0), raw(&process)) })?;
            Ok(job)
        }

        /// The ids of the processes in the job (for the tests).
        #[cfg(test)]
        pub fn pids(&self) -> io::Result<Vec<u32>> {
            use windows_sys::Win32::System::JobObjects::{
                JobObjectBasicProcessIdList, QueryInformationJobObject,
            };

            /// JOBOBJECT_BASIC_PROCESS_ID_LIST with room for 64 ids.
            #[repr(C)]
            struct List {
                assigned: u32,
                listed: u32,
                ids: [usize; 64],
            }
            let mut list = List {
                assigned: 0,
                listed: 0,
                ids: [0; 64],
            };
            // SAFETY: the structure the information class names, with its size.
            checked(unsafe {
                QueryInformationJobObject(
                    raw(&self.0),
                    JobObjectBasicProcessIdList,
                    (&mut list as *mut List).cast::<c_void>(),
                    size_of::<List>() as u32,
                    std::ptr::null_mut(),
                )
            })?;
            let listed = (list.listed as usize).min(list.ids.len());
            Ok(list.ids[..listed].iter().map(|&id| id as u32).collect())
        }

        /// End every process of the job.
        pub fn terminate(&self) -> io::Result<()> {
            // SAFETY: a plain call on a handle owned here.
            checked(unsafe { TerminateJobObject(raw(&self.0), KILLED) })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::process::CommandExt;
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant};

        use windows_sys::Win32::Foundation::STILL_ACTIVE;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        /// cmd.exe in a job, running `ping` as its child: a parent and a child process, as the sidecar and
        /// a CLI it runs are. Returned once the second ping has started, which cmd starts while
        /// it is in the job (the first may have started before), with the ids of the job's processes.
        fn tree_in_job() -> (Child, Job, Vec<u32>) {
            let parent = Command::new("cmd")
                .args([
                    "/d",
                    "/c",
                    "ping -n 2 127.0.0.1 >nul & ping -n 60 127.0.0.1 >nul",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .expect("cmd");
            let job = Job::contain(parent.id()).expect("job");
            std::thread::sleep(Duration::from_millis(2500));
            let pids = job.pids().expect("pids");
            // cmd, the second ping and cmd's console host (conhost.exe).
            assert!(pids.len() >= 2 && pids.contains(&parent.id()), "{pids:?}");
            assert!(pids.iter().all(|&pid| alive(pid)), "{pids:?}");
            (parent, job, pids)
        }

        fn alive(pid: u32) -> bool {
            // SAFETY: plain calls on a handle owned here.
            let Ok(process) =
                owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })
            else {
                return false;
            };
            let mut code = 0u32;
            let ok = unsafe { GetExitCodeProcess(raw(&process), &mut code) };
            ok != 0 && code == STILL_ACTIVE as u32
        }

        fn all_end(pids: &[u32]) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while pids.iter().any(|&pid| alive(pid)) {
                assert!(Instant::now() < deadline, "still running: {pids:?}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        #[test]
        fn closing_the_job_ends_the_parent_and_its_child() {
            let (mut parent, job, pids) = tree_in_job();
            drop(job); // As when the app exits, however it exits.
            all_end(&pids);
            assert!(parent.wait().is_ok());
        }

        #[test]
        fn terminating_the_job_ends_the_parent_and_its_child() {
            let (mut parent, job, pids) = tree_in_job();
            job.terminate().expect("terminate");
            all_end(&pids);
            assert!(parent.wait().is_ok());
        }
    }
}
