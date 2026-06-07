import { inspect } from 'util';

export class Logger {
  // 定义颜色 ANSI 码
  private static colors = {
    info: '\x1b[1;36m', // 粗明亮青
    success: '\x1b[1;32m', // 粗明亮绿
    error: '\x1b[1;31m', // 粗明亮红（新增）
    reset: '\x1b[0m', // 重置
  };
  private static getTimestamp(): string {
    const now = new Date();

    const year = now.getFullYear();
    // 月份是从 0 开始的，所以要 +1；同时用 padStart 动态补零
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const date = String(now.getDate()).padStart(2, '0');

    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
  }
  // 格式化日志元数据（时间、级别）
  private static format(
    level: 'info' | 'success' | 'error',
    message: string,
    ...args: any[]
  ): string {
    const timestamp = this.getTimestamp();
    const color = this.colors[level];
    const uppercaseLevel = level.toUpperCase().padEnd(7); // 对齐级别名称

    // 格式化主消息，如果是对象则展开
    let formattedMessage =
      typeof message === 'object' ? inspect(message, { colors: true, depth: 3 }) : message;

    // 处理剩余的参数（支持类似 console.log 的多参数传入）
    if (args.length > 0) {
      const formattedArgs = args
        .map((arg) => (typeof arg === 'object' ? inspect(arg, { colors: true, depth: 3 }) : arg))
        .join(' ');
      formattedMessage = `${formattedMessage} ${formattedArgs}`;
    }

    // 在服务器上直接输出带颜色的格式化日志
    return `[${timestamp}] ${color}${uppercaseLevel}${this.colors.reset} ${formattedMessage}`;
  }

  info(message: string, ...args: any[]) {
    console.log(Logger.format('info', message, ...args));
  }

  success(message: string, ...args: any[]) {
    console.log(Logger.format('success', message, ...args));
  }

  error(message: string, ...args: any[]) {
    console.log(Logger.format('error', message, ...args));
  }
}

export const logger = new Logger();
