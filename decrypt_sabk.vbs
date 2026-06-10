Option Explicit
Dim xl, wb, paths, p, outPath
Set xl = CreateObject("Excel.Application")
xl.DisplayAlerts = False
xl.Visible = False
xl.AskToUpdateLinks = False

paths = Array( _
  "C:\Users\jojo\Desktop\SABK0113_04.xls", _
  "C:\Users\jojo\Desktop\SABK0116_01.xls" _
)

For Each p In paths
  outPath = Replace(p, ".xls", "_decrypted.xlsx")
  On Error Resume Next
  Set wb = xl.Workbooks.Open(p, 0, True, , "0000")
  If Err.Number <> 0 Then
    WScript.Echo "FAIL_OPEN: " & p & " - " & Err.Description
    Err.Clear
  Else
    wb.SaveAs outPath, 51
    If Err.Number <> 0 Then
      WScript.Echo "FAIL_SAVE: " & p & " - " & Err.Description
      Err.Clear
    Else
      WScript.Echo "OK: " & outPath
    End If
    wb.Close False
  End If
  On Error Goto 0
Next

xl.Quit
Set xl = Nothing
