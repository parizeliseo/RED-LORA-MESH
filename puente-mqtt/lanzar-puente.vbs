' Abre el puente MQTT (puente-mqtt.py) sin mostrar ventana.
' Lo llama el boton "Iniciar puente" del portal. Ignora cualquier dato que reciba: solo arranca el puente.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
prog = carpeta & "\puente-mqtt.py"
If Not fso.FileExists(prog) Then
  MsgBox "No se encontro puente-mqtt.py en la carpeta " & carpeta & vbCrLf & "Dejalo junto a este archivo y volve a instalar el boton.", 16, "Puente OPEN SOURCE PARIZ"
  WScript.Quit 1
End If
sh.CurrentDirectory = carpeta
cmds = Array("pythonw", "pyw -3", "python", "py -3")
exes = Array("pythonw", "pyw", "python", "py")
For i = 0 To 3
  If sh.Run("cmd /c where " & exes(i) & " >nul 2>nul", 0, True) = 0 Then
    sh.Run cmds(i) & " """ & prog & """", 0, False
    WScript.Quit 0
  End If
Next
MsgBox "No se encontro Python. Instalalo desde python.org y marca ""Add Python to PATH"".", 16, "Puente OPEN SOURCE PARIZ"
