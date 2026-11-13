# Manual Windows runtime crash/orphan check (M-1)

**Status: Pending — not run from the Arena Linux workspace.** Passing this check is required before claiming the Windows desktop runtime leaves no sidecar orphans after an abrupt shell exit.

## Build under test

Use the `EnergyBaseline-Windows-NSIS-M1` artifact (artifact ID `14055932314`) from [CI run 43459781814](https://github.com/hajianamir/EnergyBaseline-Tauri-/actions/runs/43459781814). That run passed locked Windows/Ubuntu validation and the automated Windows freeze, NSIS install, resource-staging, and sidecar IPC/EOF smoke checks. Those checks do **not** launch and forcibly terminate the actual Tauri desktop process.

## Preconditions

- Windows 10 or 11, x64, in a normal interactive desktop session.
- Use a disposable Windows profile or other test environment; the abrupt termination is intentionally not a graceful close.
- Install the CI artifact as the current user and launch the installed `EnergyBaseline` app.
- Close any other EnergyBaseline instances. Do not continue if another test sidecar is running.

## Procedure

1. Wait for the app to report the sidecar **Ready** (for example, in System Status); database health is a separate signal. Record the startup time; the handshake must complete within 10 seconds. Reaching Ready from this installed build verifies that the Rust-owned launcher resolves and starts the packaged resource path. The Rust `ShellExt::shell().command(...).spawn()` call does not use the shell plugin's webview `shell:allow-spawn` capability; that unused permission was removed, and the former `$RESOURCE` entry was not an active security boundary. A package file-staging or direct sidecar smoke is not a substitute. If Ready is not reached, retain the error and resolved path, mark the runtime check failed, and do not force-terminate an unverified process.
2. Open a normal, non-elevated PowerShell session as the same user. Run both snippets in that same session. Capture and inspect the app/sidecar process tree:

   ```powershell
   $snapshot = @(Get-CimInstance Win32_Process)
   $sidecars = @($snapshot | Where-Object { $_.Name -ieq 'energybaseline_sidecar.exe' })
   if ($sidecars.Count -ne 1) {
       throw "Expected exactly one test sidecar; found $($sidecars.Count). Close other instances and retry."
   }
   $sidecar = $sidecars[0]
   $app = @($snapshot | Where-Object {
       [int]$_.ProcessId -eq [int]$sidecar.ParentProcessId
   } | Select-Object -First 1)
   if ($app.Count -ne 1 -or $app[0].Name -ine 'EnergyBaseline.exe') {
       throw 'The sidecar parent is not the expected EnergyBaseline desktop process; do not terminate it.'
   }

   function Get-Descendants {
       param([int]$ParentId, [object[]]$ProcessSnapshot)
       foreach ($candidate in $ProcessSnapshot) {
           if ([int]$candidate.ParentProcessId -eq $ParentId) {
               $candidate
               Get-Descendants -ParentId ([int]$candidate.ProcessId) -ProcessSnapshot $ProcessSnapshot
           }
       }
   }

   $targets = @($app[0], $sidecar) + @(
       Get-Descendants -ParentId ([int]$sidecar.ProcessId) -ProcessSnapshot $snapshot
   )
   $targets = @($targets | Sort-Object -Property ProcessId -Unique)
   $targets | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath | Format-Table -AutoSize
   ```

   The recursive walk records every descendant under the sidecar, including any child process spawned by the frozen PyInstaller onedir executable, not only the immediate sidecar PID. Verify the displayed app and sidecar PIDs correspond to this test instance. If the executable name differs, stop and verify the app identity manually; do not force-terminate an unverified process.
3. Force-terminate only the verified desktop app PID. The following continues polling the captured app/sidecar descendants and fails if any remain after five seconds:

   ```powershell
   $appPid = [int]$app[0].ProcessId
   $trackedNames = @{}
   foreach ($target in $targets) {
       $trackedNames[[int]$target.ProcessId] = [string]$target.Name
   }

   $timer = [System.Diagnostics.Stopwatch]::StartNew()
   Stop-Process -Id $appPid -Force -ErrorAction Stop
   do {
       $live = @(Get-CimInstance Win32_Process | Where-Object {
           $candidateId = [int]$_.ProcessId
           $trackedNames.ContainsKey($candidateId) -and $_.Name -ieq $trackedNames[$candidateId]
       })
       if ($live.Count -eq 0) { break }
       Start-Sleep -Milliseconds 100
   } while ($timer.Elapsed.TotalSeconds -lt 5)
   $timer.Stop()

   if ($live.Count -gt 0) {
       $live | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath | Format-Table -AutoSize
       throw "FAIL: captured process tree remains after $([math]::Round($timer.Elapsed.TotalSeconds, 2)) seconds."
   }
   $remainingSidecars = @(Get-CimInstance Win32_Process | Where-Object {
       $_.Name -ieq 'energybaseline_sidecar.exe'
   })
   if ($remainingSidecars.Count -gt 0) {
       $remainingSidecars | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath | Format-Table -AutoSize
       throw 'FAIL: an energybaseline_sidecar.exe process remains.'
   }
   "PASS: captured app/sidecar process tree exited in $([math]::Round($timer.Elapsed.TotalSeconds, 2)) seconds."
   ```

## Pass criteria and evidence

- The sidecar reaches Ready within 10 seconds.
- After the abrupt app termination, every captured app/sidecar process exits and no `energybaseline_sidecar.exe` remains within 5 seconds.
- Record the Windows version/build, CI run/artifact, startup time, captured PIDs/process names, and measured exit time. Keep evidence free of database URLs, credentials, and user data.
- If any process remains, record its PID/name and elapsed time, retain non-sensitive process output, and mark the check **failed**. Do not infer success from the CI Job Object unit test or installer smoke test alone.
