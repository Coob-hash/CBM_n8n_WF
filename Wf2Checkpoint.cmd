@echo off
setlocal
set "CBM_CHECKPOINT_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%CBM_CHECKPOINT_PYTHON%" (
  "%CBM_CHECKPOINT_PYTHON%" "%~dp0Wf2Checkpoint.py" %*
) else (
  py -3 "%~dp0Wf2Checkpoint.py" %*
)
exit /b %errorlevel%
