# Extract login token from running PicWish.exe process memory
# Usage: powershell -ExecutionPolicy Bypass -File scan-memory.ps1 [pid]
param([int]$Pid = 34132)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinMem {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION info, IntPtr len);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }
}
"@

$PROCESS_VM_READ = 0x0010
$PROCESS_QUERY_INFORMATION = 0x0400
$MEM_COMMIT = 0x1000
$PAGE_READABLE = @(0x02,0x04,0x08,0x20,0x40,0x80)

$h = [WinMem]::OpenProcess($PROCESS_VM_READ -bor $PROCESS_QUERY_INFORMATION, $false, $Pid)
if ($h -eq [IntPtr]::Zero) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Output "OpenProcess failed, error $err (try running as admin)"
    exit 1
}

# patterns: ASCII and UTF-16LE variants
$asciiPats = @('Bearer ', 'api_token', 'eyJhbGci', 'passport_api_token', 'Authorization')
$results = New-Object System.Collections.ArrayList
$addr = [IntPtr]::Zero
$info = New-Object WinMem+MEMORY_BASIC_INFORMATION
$infoSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
$scanned = 0L
$maxScan = 3GB

while ($addr.ToInt64() -lt 0x7FFFFFFFFFF -and $scanned -lt $maxScan) {
    $r = [WinMem]::VirtualQueryEx($h, $addr, [ref]$info, $infoSize)
    if ($r -eq [IntPtr]::Zero) { break }
    $regionSize = $info.RegionSize.ToInt64()
    $isCommit = ($info.State -band $MEM_COMMIT) -ne 0
    $isReadable = $PAGE_READABLE -contains $info.Protect
    if ($isCommit -and $isReadable -and $regionSize -gt 0 -and $regionSize -lt 512MB) {
        $off = 0L
        while ($off -lt $regionSize) {
            $chunk = [Math]::Min(4MB, $regionSize - $off)
            $buf = New-Object byte[] $chunk
            $read = [IntPtr]::Zero
            $ok = [WinMem]::ReadProcessMemory($h, [IntPtr]::Add($info.BaseAddress, $off), $buf, $chunk, [ref]$read)
            if ($ok -and $read.ToInt64() -gt 0) {
                $n = $read.ToInt64()
                # ASCII search
                $text = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
                foreach ($pat in $asciiPats) {
                    $idx = $text.IndexOf($pat)
                    while ($idx -ge 0 -and $results.Count -lt 80) {
                        $start = [Math]::Max(0, $idx - 40)
                        $len = [Math]::Min(300, $text.Length - $start)
                        $snippet = ($text.Substring($start, $len) -replace '[^\x20-\x7E]', '.').Trim()
                        $regionAddr = ([IntPtr]::Add($info.BaseAddress, $off)).ToInt64() + $idx
                        $entry = "ASCII '{0}' @0x{1:X}: {2}" -f $pat, $regionAddr, $snippet
                        if (-not $results.Contains($entry)) { [void]$results.Add($entry) }
                        $idx = $text.IndexOf($pat, $idx + 1)
                    }
                }
                # UTF-16LE search for 'token' / 'Bearer'
                $utext = [Text.Encoding]::Unicode.GetString($buf, 0, $n)
                foreach ($upat in @('api_token', 'Bearer ', 'eyJhbGci')) {
                    $uidx = $utext.IndexOf($upat)
                    while ($uidx -ge 0 -and $results.Count -lt 80) {
                        $ustart = [Math]::Max(0, $uidx - 40)
                        $ulen = [Math]::Min(300, $utext.Length - $ustart)
                        $usnippet = ($utext.Substring($ustart, $ulen) -replace '[^\x20-\x7E]', '.').Trim()
                        $uregionAddr = ([IntPtr]::Add($info.BaseAddress, $off)).ToInt64() + ($uidx * 2)
                        $entry = "UTF16 '{0}' @0x{1:X}: {2}" -f $upat, $uregionAddr, $usnippet
                        if (-not $results.Contains($entry)) { [void]$results.Add($entry) }
                        $uidx = $utext.IndexOf($upat, $uidx + 1)
                    }
                }
            }
            $off += $chunk
            $scanned += $chunk
        }
    }
    $addr = [IntPtr]::Add($info.BaseAddress, $regionSize)
    if ($addr.ToInt64() -le 0) { break }
}
[WinMem]::CloseHandle($h) | Out-Null
Write-Output ("Scan done: {0} MB, {1} matches" -f [Math]::Round($scanned/1MB), $results.Count)
$results | ForEach-Object { Write-Output $_ }
