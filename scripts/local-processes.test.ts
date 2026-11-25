import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { waitForChildren } from './local-processes.js';

test('a failed local service rejects the launcher and stops its console sibling', async () => {
  const service = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
  const console = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const stopped = once(console, 'exit');
  try {
    await assert.rejects(
      waitForChildren(
        [service, console],
        () => false,
        () => {
          service.kill();
          console.kill();
        },
      ),
      /Local process exited unexpectedly.*code 1/,
    );
    await stopped;
  } finally {
    service.kill();
    console.kill();
    await stopped;
  }
});

test('an unsolicited clean child exit is still a stopped local stack', async () => {
  const service = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  try {
    await assert.rejects(
      waitForChildren(
        [service],
        () => false,
        () => service.kill(),
      ),
      /code 0/,
    );
  } finally {
    service.kill();
  }
});

test('an intentional shutdown remains successful', async () => {
  const service = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  let stopping = false;
  const finished = waitForChildren(
    [service],
    () => stopping,
    () => service.kill(),
  );
  stopping = true;
  service.kill('SIGTERM');
  await finished;
});

test(
  'a child that exited before readiness cannot leave the launcher hanging',
  { timeout: 2000 },
  async () => {
    const service = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
    await once(service, 'exit');
    await assert.rejects(
      waitForChildren(
        [service],
        () => false,
        () => service.kill(),
      ),
      /code 1/,
    );
  },
);

test(
  'a lost database-ownership connection restarts only the backend',
  { timeout: 3000 },
  async () => {
    const service = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(75), 20)'], {
      stdio: 'ignore',
    });
    const web = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const children = [service, web];
    let stopping = false;
    let markRestarted!: () => void;
    const restarted = new Promise<void>((resolve) => {
      markRestarted = resolve;
    });
    const stop = () => {
      for (const child of children) child.kill();
    };
    const finished = waitForChildren(children, () => stopping, stop, {
      service,
      maxRestarts: 1,
      delayMs: 5,
      start: () => {
        const replacement = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        children.push(replacement);
        markRestarted();
        return replacement;
      },
    });
    try {
      await Promise.race([
        restarted,
        finished.then(() => {
          throw Error('Stack stopped before recovering');
        }),
      ]);
      assert.equal(web.exitCode, null, 'The console must remain alive through backend recovery');
      assert.notEqual(children[2].pid, service.pid);
      stopping = true;
      stop();
      await finished;
    } finally {
      stopping = true;
      stop();
      await finished.catch(() => {});
    }
  },
);

test(
  'repeated ownership failures exhaust recovery and stop the console',
  { timeout: 3000 },
  async () => {
    const temporary = () =>
      spawn(process.execPath, ['-e', 'process.exit(75)'], { stdio: 'ignore' });
    const service = temporary();
    const web = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const ended = once(web, 'exit');
    const children = [service, web];
    let starts = 0;
    try {
      await assert.rejects(
        waitForChildren(
          children,
          () => false,
          () => children.forEach((child) => child.kill()),
          {
            service,
            maxRestarts: 2,
            delayMs: 5,
            start: () => {
              starts++;
              const next = temporary();
              children.push(next);
              return next;
            },
          },
        ),
        /recovery limit reached/,
      );
      assert.equal(starts, 2);
      await ended;
    } finally {
      children.forEach((child) => child.kill());
      await ended;
    }
  },
);

test('frontend failure cancels a pending backend restart', { timeout: 3000 }, async () => {
  const service = spawn(process.execPath, ['-e', 'process.exit(75)'], { stdio: 'ignore' });
  const web = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const children = [service, web];
  let starts = 0;
  try {
    await assert.rejects(
      waitForChildren(
        children,
        () => false,
        () => children.forEach((child) => child.kill()),
        {
          service,
          delayMs: 80,
          onRestart: () => web.kill(),
          start: () => {
            starts++;
            throw Error('Must not start after console exit');
          },
        },
      ),
      /Local process exited unexpectedly/,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(starts, 0);
  } finally {
    children.forEach((child) => child.kill());
  }
});

test(
  'Ctrl+C during recovery cancels restart and exits successfully',
  { timeout: 3000 },
  async () => {
    const service = spawn(process.execPath, ['-e', 'process.exit(75)'], { stdio: 'ignore' });
    const web = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const children = [service, web];
    let stopping = false,
      starts = 0;
    try {
      await waitForChildren(
        children,
        () => stopping,
        () => children.forEach((child) => child.kill()),
        {
          service,
          delayMs: 80,
          onRestart: () => {
            stopping = true;
            web.kill();
          },
          start: () => {
            starts++;
            throw Error('Must not restart during shutdown');
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(starts, 0);
    } finally {
      children.forEach((child) => child.kill());
    }
  },
);

test('nonrecoverable backend errors are not retried', async () => {
  const service = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
  let starts = 0;
  await assert.rejects(
    waitForChildren(
      [service],
      () => false,
      () => service.kill(),
      {
        service,
        start: () => {
          starts++;
          throw Error('Must not retry configuration errors');
        },
      },
    ),
    /code 1/,
  );
  assert.equal(starts, 0);
});

test(
  'a stable backend resets the recovery budget for a later outage',
  { timeout: 3000 },
  async () => {
    const temporary = (uptime: number) =>
      spawn(process.execPath, ['-e', `setTimeout(() => process.exit(75), ${uptime})`], {
        stdio: 'ignore',
      });
    const service = temporary(0);
    const web = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const children = [service, web];
    let starts = 0,
      stopping = false;
    let markRecovered!: () => void;
    const recovered = new Promise<void>((resolve) => {
      markRecovered = resolve;
    });
    const stop = () => children.forEach((child) => child.kill());
    const finished = waitForChildren(children, () => stopping, stop, {
      service,
      maxRestarts: 1,
      delayMs: 5,
      stableAfterMs: 40,
      start: () => {
        starts++;
        const next =
          starts === 1
            ? temporary(80)
            : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        children.push(next);
        if (starts === 2) markRecovered();
        return next;
      },
    });
    try {
      await Promise.race([
        recovered,
        finished.then(() => {
          throw Error('Later outage was not recovered');
        }),
      ]);
      assert.equal(starts, 2);
      assert.equal(web.exitCode, null);
      stopping = true;
      stop();
      await finished;
    } finally {
      stopping = true;
      stop();
      await finished.catch(() => {});
    }
  },
);

test('a frontend using the temporary-failure code is still fatal', async () => {
  const service = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const web = spawn(process.execPath, ['-e', 'process.exit(75)'], { stdio: 'ignore' });
  const ended = once(service, 'exit');
  let starts = 0;
  try {
    await assert.rejects(
      waitForChildren(
        [service, web],
        () => false,
        () => {
          service.kill();
          web.kill();
        },
        {
          service,
          start: () => {
            starts++;
            throw Error('Frontend failure must not restart the backend');
          },
        },
      ),
      /code 75/,
    );
    assert.equal(starts, 0);
    await ended;
  } finally {
    service.kill();
    web.kill();
    await ended;
  }
});
