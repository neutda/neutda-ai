# Windows 콘솔 한글 출력: UTF-8(65001) 또는 CP949 콘솔 모두 지원
$cp = [Console]::OutputEncoding.CodePage
if ($cp -eq 65001) {
    $enc = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $enc
    [Console]::InputEncoding = $enc
    $OutputEncoding = $enc
}
