"""One cross-process lock per model lineage, on Windows and POSIX."""
from contextlib import contextmanager
import os
from pathlib import Path
import threading
import time

_threads=threading.RLock()

@contextmanager
def model_lock(directory: Path, timeout=60):
    directory.mkdir(parents=True,exist_ok=True)
    with _threads, open(directory/'maintenance.lock','a+b') as handle:
        handle.seek(0,os.SEEK_END)
        if not handle.tell():
            handle.write(b'0');handle.flush()
        deadline=time.monotonic()+timeout
        while True:
            try:
                handle.seek(0)
                if os.name=='nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except (OSError,BlockingIOError):
                if time.monotonic()>=deadline:raise TimeoutError('IFC model writer is busy')
                time.sleep(.05)
        try:yield
        finally:
            handle.seek(0)
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(),fcntl.LOCK_UN)

def atomic_text(path:Path,text:str):
    import uuid
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with open(temp,'w',encoding='utf-8',newline='\n') as handle:
        handle.write(text);handle.flush();os.fsync(handle.fileno())
    os.replace(temp,path)
