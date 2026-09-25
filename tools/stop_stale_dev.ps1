# 開発用: 前回の起動で残った本アプリのプロセスを止める
#
# 指定ポートで待ち受けているプロセスのうち、実行ファイルかコマンドラインが
# このリポジトリ配下を指すもの (本人または親) だけを止める。
# 別のアプリがポートを使っている場合は止めずにエラーで終わる。
param(
    [int[]]$Port = @(),
    # リポジトリからの相対パス。起動中ならポートに関係なく止める
    [string[]]$ExePath = @()
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path.TrimEnd("\")
# 末尾の区切りまで含めて比べ、paper-desk-old のような隣のフォルダーを本アプリと取り違えない
$repoPrefix = "$repoRoot\"

function Get-ProcessInfo([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-InRepo($Proc) {
    if ($null -eq $Proc) { return $false }
    foreach ($text in @($Proc.ExecutablePath, $Proc.CommandLine)) {
        if ($text -and $text.Replace("/", "\").IndexOf($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Stop-Target($Proc, [string]$Message) {
    Write-Host "${Message}: PID $($Proc.ProcessId) $($Proc.Name)"
    Stop-Process -Id $Proc.ProcessId -Force -ErrorAction SilentlyContinue
    # 終了は非同期なので、exe のロックやポートが外れるまで待つ
    Wait-Process -Id $Proc.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-Process -Id $Proc.ProcessId -ErrorAction SilentlyContinue) {
        Write-Host "PID $($Proc.ProcessId) を止められませんでした"
        exit 1
    }
}

foreach ($p in $Port) {
    $owners = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($ownerId in $owners) {
        $proc = Get-ProcessInfo $ownerId
        if ($null -eq $proc) { continue }
        $parent = Get-ProcessInfo $proc.ParentProcessId
        # 親が先に終わっていると、その PID が後から起動した別のプロセスに再利用されていることがある
        if ($parent -and $parent.CreationDate -gt $proc.CreationDate) { $parent = $null }
        if (-not ((Test-InRepo $proc) -or (Test-InRepo $parent))) {
            Write-Host "ポート $p は本アプリ以外のプロセスが使っているため止めません: PID $($proc.ProcessId) $($proc.Name) $($proc.ExecutablePath)"
            exit 1
        }
        Stop-Target $proc "ポート $p に残っていた本アプリのプロセスを止めます"
        # PyInstaller の onefile や uv の venv ランチャーは同じ役割の親を持つので一緒に止める
        if ($parent -and $parent.ExecutablePath -and
            $parent.ExecutablePath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Target $parent "その親プロセスも止めます"
        }
    }
    for ($i = 0; $i -lt 50; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 100
    }
    if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "ポート $p が解放されませんでした"
        exit 1
    }
}

foreach ($rel in $ExePath) {
    $full = [IO.Path]::GetFullPath((Join-Path $repoRoot $rel))
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $full } |
        ForEach-Object { Stop-Target $_ "起動中の $rel を止めます" }
}
