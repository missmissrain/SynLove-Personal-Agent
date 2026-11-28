"""输出上界测试Worker。无参数；持续输出假字节，验证服务及时终止超限进程。"""
import sys

sys.stdin.buffer.readline()
while True:
    sys.stdout.buffer.write(b"x" * 65536)
    sys.stdout.buffer.flush()
