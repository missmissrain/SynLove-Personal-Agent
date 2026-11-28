"""主启动器实际跨进程互斥测试；只访问临时锁文件，不启动生产服务；无注册参数。"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class InstanceLockTests(unittest.TestCase):
    """验证两个独立 Python 进程争抢主启动锁与退出后接管。"""

    def test_startup_lock_blocks_other_process_and_releases(self):
        """同一路径只允许一个持锁进程；释放后第二个进程能正常接管。"""
        with tempfile.TemporaryDirectory() as temp:
            lock = str(Path(temp)/"stack.lock")
            code = ("import sys;from pathlib import Path;import start_stack;"
                    "start_stack.LOCK_FILE=Path(sys.argv[1]);"
                    "ok=start_stack.acquire_lock();print('ACQUIRED='+str(ok),flush=True);"
                    "sys.stdin.readline() if ok else None;"
                    "start_stack.release_lock() if ok else None")
            env = {**os.environ,"PYTHONUTF8":"1"}
            options = {"creationflags":getattr(subprocess,"CREATE_NO_WINDOW",0)}
            first = subprocess.Popen([sys.executable,"-c",code,lock],cwd=ROOT,env=env,
                                     stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**options)
            try:
                line=first.stdout.readline().decode("utf-8")
                self.assertIn("ACQUIRED=True",line)
                second=subprocess.run([sys.executable,"-c",code,lock],cwd=ROOT,env=env,input=b"\n",
                                      capture_output=True,timeout=20,**options)
                self.assertEqual(second.returncode,0)
                self.assertIn(b"ACQUIRED=False",second.stdout)
                self.assertIsNone(first.poll())
            finally:
                first.communicate(b"\n",timeout=20)
            third=subprocess.run([sys.executable,"-c",code,lock],cwd=ROOT,env=env,input=b"\n",
                                 capture_output=True,timeout=20,**options)
            self.assertEqual(third.returncode,0)
            self.assertIn(b"ACQUIRED=True",third.stdout)


if __name__=="__main__":
    unittest.main()
