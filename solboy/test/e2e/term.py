# Drive the packaged app's terminal menu through a real pty, typing each answer in turn.
import os, pty, sys, time, select, re
exe, *answers = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.path.dirname(exe)); os.execv(exe, [exe])
out = b''
def pump(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: out += os.read(fd, 65536)
            except OSError: return False
    return True
pump(4)
for a in answers:
    os.write(fd, (a + '\r').encode())
    if not pump(2.5 if a.startswith(('ask', 'Ek')) else 1.2): break
pump(2)
print(re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', out.decode(errors='replace')))
try: os.kill(pid, 9)
except: pass
