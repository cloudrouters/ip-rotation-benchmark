import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROTATIONS = 1;

const IP_CHECK_URL = 'https://api.ipify.org/?format=json';

const ROTATION_TIMEOUT = 5 * 60 * 1000;
const POLL_INTERVAL = 5000;

const CURL_CONNECT_TIMEOUT = 10;
const CURL_MAX_TIME = 15;
const CHANGE_IP_TIMEOUT = 30;

const CHANGE_IP_RETRY_INTERVAL = 250;
const CHANGE_IP_RETRY_TIMEOUT = 30 * 1000;

const STATS_INTERVAL = 10;

const ROUTER_NOT_READY_MESSAGE =
    'Router is not available. Please try again later.';

const COLORS = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m'
} as const;

type Mode = 'normal' | 'no-repeat';

type RotationCount =
    | number
    | 'infinite';

interface Args {
    changeIpUrl?: string;
    proxyUrl?: string;

    mode: Mode;

    rotations: RotationCount;
    rotationsSpecified: boolean;

    intervalSeconds: number;
    intervalSpecified: boolean;

    deleteData: boolean;
}

interface CurlResult {
    success: boolean;
    stdout: string;
    stderr: string;
    error: string | null;
    timedOut: boolean;
    durationMs: number;
    exitCode: number | null;
}

interface IpResult {
    success: boolean;
    ip: string | null;
    error: string | null;
}

interface ChangeIpResult {
    retryLimitReached: boolean;
}

interface RotationResult {
    rotation: number;
    success: boolean;
    newIp: string | null;
    durationMs: number;
    isRepeat: boolean;
    successAt: number | null;
    attempts: number;
}

interface DuplicateRecovery {
    rotation: number;
    attempts: number;
    additionalTimeMs: number;
}

interface PersistedState {
    version: 1;
    mode: Mode;

    changeIpUrl: string;
    proxyUrl: string;

    totalRotations: RotationCount;
    completedRotations: number;

    intervalSeconds: number;

    testStartedAt: number;

    initialIp: string;
    currentIp: string;

    ipHistory: Record<string, number[]>;

    results: RotationResult[];

    duplicateRecoveries: DuplicateRecovery[];
}

const SCRIPT_DIR = path.dirname(
    fileURLToPath(import.meta.url)
);

const DATA_FILES: Record<Mode, string> = {
    normal: path.join(
        SCRIPT_DIR,
        'rotation-results.json'
    ),

    'no-repeat': path.join(
        SCRIPT_DIR,
        'rotation-results-no-repeat.json'
    )
};

function color(
    text: string,
    colorName: keyof typeof COLORS
): string {
    return `${COLORS[colorName]}${text}${COLORS.reset}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) =>
        setTimeout(resolve, ms)
    );
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms)) {
        return '-';
    }

    return `${(ms / 1000).toFixed(1)} sec`;
}

function formatElapsed(ms: number): string {
    if (!Number.isFinite(ms)) {
        return '-';
    }

    const totalSeconds = Math.max(
        0,
        Math.floor(ms / 1000)
    );

    const hours = Math.floor(
        totalSeconds / 3600
    );

    const minutes = Math.floor(
        (totalSeconds % 3600) / 60
    );

    const seconds =
        totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
}

function formatPercent(
    value: number
): string {
    return `${Math.round(value)}%`;
}

function percentile(
    values: number[],
    percentileValue: number
): number {
    if (!values.length) {
        return 0;
    }

    const sorted = [...values].sort(
        (a, b) => a - b
    );

    const index =
        (sorted.length - 1) *
        percentileValue;

    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
        return sorted[lower];
    }

    return (
        sorted[lower] +
        (sorted[upper] - sorted[lower]) *
            (index - lower)
    );
}

function maskProxyUrl(
    url: string
): string {
    try {
        const parsed = new URL(url);

        if (parsed.password) {
            parsed.password = '***';
        }

        return parsed
            .toString()
            .replace(/\/$/, '');
    } catch {
        return url.replace(
            /(:\/\/[^:]+:)[^@]+(@)/,
            '$1***$2'
        );
    }
}

function parseArgs(
    argv: string[]
): Args {
    const positional: string[] = [];

    let mode: Mode = 'normal';

    let rotations: RotationCount =
        DEFAULT_ROTATIONS;

    let rotationsSpecified = false;

    let intervalSeconds = 0;

    let intervalSpecified = false;

    let deleteData = false;

    for (const arg of argv) {
        if (arg === '--no-repeat') {
            mode = 'no-repeat';
            continue;
        }

        if (arg === '--delete-data') {
            deleteData = true;
            continue;
        }

        if (arg.startsWith('--rotations=')) {
            const value =
                arg.slice(
                    '--rotations='.length
                );

            if (
                value ===
                'infinite'
            ) {
                rotations =
                    'infinite';

                rotationsSpecified =
                    true;

                continue;
            }

            const parsed =
                Number(value);

            if (
                !Number.isInteger(
                    parsed
                ) ||
                parsed < 1
            ) {
                throw new Error(
                    '--rotations must be a positive integer or "infinite".'
                );
            }

            rotations = parsed;

            rotationsSpecified =
                true;

            continue;
        }

        if (arg === '--rotations') {
            throw new Error(
                'Use --rotations=NUMBER or --rotations=infinite.'
            );
        }

        if (arg.startsWith('--interval=')) {
            const value =
                arg.slice(
                    '--interval='.length
                );

            const parsed =
                Number(value);

            if (
                !Number.isFinite(
                    parsed
                ) ||
                parsed < 0
            ) {
                throw new Error(
                    '--interval must be a non-negative number.'
                );
            }

            intervalSeconds =
                parsed;

            intervalSpecified =
                true;

            continue;
        }

        if (arg === '--interval') {
            throw new Error(
                'Use --interval=SECONDS.'
            );
        }

        if (arg.startsWith('--')) {
            throw new Error(
                `Unknown option: ${arg}`
            );
        }

        positional.push(arg);
    }

    return {
        changeIpUrl: positional[0],
        proxyUrl: positional[1],

        mode,

        rotations,
        rotationsSpecified,

        intervalSeconds,
        intervalSpecified,

        deleteData
    };
}

function printUsage(): void {
    console.log(`
Usage:

  node rotation-test.js "<CHANGE-IP URL>" "<SOCKS5 PROXY>"

  node rotation-test.js "<CHANGE-IP URL>" "<SOCKS5 PROXY>" --rotations=500

  node rotation-test.js "<CHANGE-IP URL>" "<SOCKS5 PROXY>" --rotations=infinite

  node rotation-test.js "<CHANGE-IP URL>" "<SOCKS5 PROXY>" --no-repeat

  node rotation-test.js "<CHANGE-IP URL>" "<SOCKS5 PROXY>" --no-repeat --rotations=500

  node rotation-test.js "<CHANGE-IP URL>" "<SOCKS5 PROXY>" --interval=30

  node rotation-test.js --delete-data

  node rotation-test.js --delete-data --no-repeat


Default:
  1 additional rotation per invocation

Rotation count:
  --rotations=NUMBER
  --rotations=infinite
`);
}

function getDataFile(
    mode: Mode
): string {
    return DATA_FILES[mode];
}

async function deleteDataFile(
    mode: Mode
): Promise<void> {
    const file = getDataFile(mode);

    try {
        await fs.unlink(file);

        console.log(
            `Deleted: ${file}`
        );
    } catch (error) {
        const nodeError =
            error as NodeJS.ErrnoException;

        if (
            nodeError.code === 'ENOENT'
        ) {
            console.log(
                `No saved data found: ${file}`
            );

            return;
        }

        throw error;
    }
}

async function loadState(
    mode: Mode
): Promise<PersistedState | null> {
    const file = getDataFile(mode);

    try {
        const raw =
            await fs.readFile(
                file,
                'utf8'
            );

        const state =
            JSON.parse(
                raw
            ) as PersistedState;

        if (
            state.version !== 1 ||
            state.mode !== mode ||
            !state.changeIpUrl ||
            !state.proxyUrl ||
            !Array.isArray(
                state.results
            ) ||
            !state.ipHistory
        ) {
            throw new Error(
                'Saved rotation data has an invalid format.'
            );
        }

        if (
            typeof state.intervalSeconds !==
            'number'
        ) {
            state.intervalSeconds =
                0;
        }

        return state;
    } catch (error) {
        const nodeError =
            error as NodeJS.ErrnoException;

        if (
            nodeError.code === 'ENOENT'
        ) {
            return null;
        }

        throw error;
    }
}

async function saveState(
    state: PersistedState
): Promise<void> {
    const file =
        getDataFile(state.mode);

    const temporaryFile =
        `${file}.tmp`;

    const json =
        JSON.stringify(
            state,
            null,
            2
        );

    await fs.writeFile(
        temporaryFile,
        json,
        'utf8'
    );

    await fs.rename(
        temporaryFile,
        file
    );
}

function createState(
    mode: Mode,
    changeIpUrl: string,
    proxyUrl: string,
    rotations: RotationCount,
    intervalSeconds: number,
    initialIp: string
): PersistedState {
    return {
        version: 1,

        mode,

        changeIpUrl,
        proxyUrl,

        totalRotations: rotations,
        completedRotations: 0,

        intervalSeconds,

        testStartedAt: Date.now(),

        initialIp,
        currentIp: initialIp,

        ipHistory: {
            [initialIp]: [0]
        },

        results: [],

        duplicateRecoveries: []
    };
}

function validateStateForRun(
    state: PersistedState,
    changeIpUrl: string,
    proxyUrl: string,
    requestedRotations: RotationCount,
    requestedInterval: number,
    intervalSpecified: boolean,
    rotationsSpecified: boolean
): void {
    if (
        state.changeIpUrl !==
        changeIpUrl
    ) {
        throw new Error(
            'Saved data belongs to a different Change-IP URL. ' +
            'Use --delete-data to start a new test.'
        );
    }

    if (
        state.proxyUrl !==
        proxyUrl
    ) {
        throw new Error(
            'Saved data belongs to a different proxy. ' +
            'Use --delete-data to start a new test.'
        );
    }

    /*
     * No --rotations specified:
     *
     * This invocation performs exactly
     * one additional rotation.
     */
    if (
        !rotationsSpecified
    ) {
        state.totalRotations =
            state.completedRotations +
            1;
    }

    /*
     * Explicit --rotations=N or
     * --rotations=infinite.
     */
    else {
        if (
            requestedRotations !==
                'infinite' &&
            state.completedRotations >
                requestedRotations
        ) {
            throw new Error(
                `Saved test already contains ${state.completedRotations} completed rotations. ` +
                `Requested total: ${requestedRotations}. ` +
                `Use --delete-data to start a new test.`
            );
        }

        state.totalRotations =
            requestedRotations;
    }

    if (
        intervalSpecified
    ) {
        state.intervalSeconds =
            requestedInterval;
    }
}

function runCurl(
    args: string[],
    timeoutMs: number
): Promise<CurlResult> {
    return new Promise(
        (resolve) => {
            const startedAt =
                Date.now();

            const child =
                spawn(
                    'curl.exe',
                    args,
                    {
                        windowsHide: true,

                        stdio: [
                            'ignore',
                            'pipe',
                            'pipe'
                        ]
                    }
                );

            let stdout = '';
            let stderr = '';
            let finished = false;

            const timer =
                setTimeout(() => {
                    if (finished) {
                        return;
                    }

                    try {
                        child.kill();
                    } catch {
                        // Ignore kill errors.
                    }

                    finish({
                        success: false,
                        stdout,
                        stderr,
                        error: 'timeout',
                        timedOut: true,
                        exitCode: null
                    });
                }, timeoutMs);

            function finish(
                result: Omit<
                    CurlResult,
                    'durationMs'
                >
            ): void {
                if (finished) {
                    return;
                }

                finished = true;

                clearTimeout(timer);

                resolve({
                    ...result,
                    durationMs:
                        Date.now() -
                        startedAt
                });
            }

            child.stdout.on(
                'data',
                (data: Buffer) => {
                    stdout +=
                        data.toString();
                }
            );

            child.stderr.on(
                'data',
                (data: Buffer) => {
                    stderr +=
                        data.toString();
                }
            );

            child.on(
                'error',
                (error: Error) => {
                    finish({
                        success: false,
                        stdout,
                        stderr,
                        error:
                            error.message,
                        timedOut: false,
                        exitCode: null
                    });
                }
            );

            child.on(
                'close',
                (code) => {
                    finish({
                        success:
                            code === 0,
                        stdout,
                        stderr,
                        error:
                            code === 0
                                ? null
                                : `curl exited with code ${code}`,
                        timedOut: false,
                        exitCode: code
                    });
                }
            );
        }
    );
}

async function getProxyIp(
    proxyUrl: string
): Promise<IpResult> {
    const result =
        await runCurl(
            [
                '--silent',
                '--show-error',

                '--connect-timeout',
                String(
                    CURL_CONNECT_TIMEOUT
                ),

                '--max-time',
                String(
                    CURL_MAX_TIME
                ),

                '--proxy',
                proxyUrl,

                IP_CHECK_URL
            ],

            CURL_MAX_TIME *
                1000 +
                1000
        );

    if (
        !result.success ||
        result.timedOut
    ) {
        return {
            success: false,
            ip: null,

            error:
                result.timedOut
                    ? 'timeout'
                    : result.error ||
                      result.stderr.trim() ||
                      'curl failed'
        };
    }

    try {
        const data: unknown =
            JSON.parse(
                result.stdout.trim()
            );

        if (
            typeof data !==
                'object' ||
            data === null ||
            !('ip' in data) ||
            typeof data.ip !==
                'string'
        ) {
            return {
                success: false,
                ip: null,
                error:
                    'Invalid IP API response'
            };
        }

        const ip =
            data.ip.trim();

        if (!ip) {
            return {
                success: false,
                ip: null,
                error: 'Empty IP'
            };
        }

        return {
            success: true,
            ip,
            error: null
        };
    } catch (error) {
        return {
            success: false,
            ip: null,

            error:
                error instanceof Error
                    ? error.message
                    : String(error)
        };
    }
}

function parseChangeIpResponse(
    stdout: string
): {
    type:
        | 'empty'
        | 'error'
        | 'other';

    message: string | null;
} {
    const body =
        stdout.trim();

    if (!body) {
        return {
            type: 'empty',
            message: null
        };
    }

    try {
        const data: unknown =
            JSON.parse(body);

        if (
            typeof data ===
                'object' &&
            data !== null &&
            'error' in data &&
            typeof data.error ===
                'object' &&
            data.error !== null &&
            'message' in
                data.error &&
            typeof data.error
                .message ===
                'string'
        ) {
            return {
                type: 'error',
                message:
                    data.error.message
            };
        }

        return {
            type: 'other',
            message: null
        };
    } catch {
        return {
            type: 'other',
            message: null
        };
    }
}

async function requestChangeIp(
    changeIpUrl: string,
    token: string
): Promise<ChangeIpResult> {
    const retryDeadline =
        Date.now() +
        CHANGE_IP_RETRY_TIMEOUT;

    while (true) {
        const result =
            await runCurl(
                [
                    '--silent',
                    '--show-error',

                    '--request',
                    'POST',

                    changeIpUrl,

                    '--header',
                    `Authorization: Bearer ${token}`,

                    '--connect-timeout',
                    String(
                        CURL_CONNECT_TIMEOUT
                    ),

                    '--max-time',
                    String(
                        CHANGE_IP_TIMEOUT
                    )
                ],

                CHANGE_IP_TIMEOUT *
                    1000 +
                    1000
            );

        const response =
            parseChangeIpResponse(
                result.stdout
            );

        if (
            response.type ===
                'error' &&
            response.message ===
                ROUTER_NOT_READY_MESSAGE
        ) {
            if (
                Date.now() >=
                retryDeadline
            ) {
                return {
                    retryLimitReached:
                        true
                };
            }

            await sleep(
                CHANGE_IP_RETRY_INTERVAL
            );

            continue;
        }

        return {
            retryLimitReached:
                false
        };
    }
}

async function waitForNewIp(
    proxyUrl: string,
    previousIp: string,
    rotationStartedAt: number
): Promise<{
    success: boolean;
    newIp: string | null;
    durationMs: number;
}> {
    const deadline =
        rotationStartedAt +
        ROTATION_TIMEOUT;

    while (
        Date.now() <
        deadline
    ) {
        const result =
            await getProxyIp(
                proxyUrl
            );

        if (
            result.success &&
            result.ip !==
                previousIp
        ) {
            return {
                success: true,

                newIp:
                    result.ip,

                durationMs:
                    Date.now() -
                    rotationStartedAt
            };
        }

        if (
            Date.now() >=
            deadline
        ) {
            break;
        }

        await sleep(
            POLL_INTERVAL
        );
    }

    return {
        success: false,

        newIp: null,

        durationMs:
            Date.now() -
            rotationStartedAt
    };
}

function getStatistics(
    results: RotationResult[],
    ipHistory: Map<
        string,
        number[]
    >
) {
    const successful =
        results.filter(
            (result) =>
                result.success
        );

    const durations =
        successful
            .map(
                (result) =>
                    result.durationMs
            )
            .filter(
                Number.isFinite
            );

    const repeatedIps =
        successful.filter(
            (result) =>
                result.isRepeat
        ).length;

    const successTimes =
        successful
            .map(
                (result) =>
                    result.successAt
            )
            .filter(
                (
                    value
                ): value is number =>
                    Number.isFinite(
                        value
                    )
            )
            .sort(
                (a, b) =>
                    a - b
            );

    const firstRotation =
        results.find(
            (result) =>
                result.rotation ===
                    1 &&
                result.success
        );

    const intervals: number[] =
        [];

    for (
        let i = 1;
        i <
            successTimes.length;
        i++
    ) {
        intervals.push(
            successTimes[i] -
                successTimes[i - 1]
        );
    }

    const averageInterval =
        intervals.length
            ? intervals.reduce(
                  (
                      sum,
                      value
                  ) =>
                      sum + value,
                  0
              ) /
              intervals.length
            : 0;

    const maxIpsPerHour =
        averageInterval > 0
            ? 3600000 /
              averageInterval
            : 0;

    return {
        totalRequests:
            results.length,

        successfulRotations:
            successful.length,

        failedRotations:
            results.length -
            successful.length,

        uniqueIps:
            ipHistory.size,

        repeatedIps,

        repeatedIpShare:
            successful.length
                ? (repeatedIps /
                      successful.length) *
                  100
                : 0,

        firstNewIpTime:
            firstRotation
                ? firstRotation.durationMs
                : 0,

        averageInterval,

        maxIpsPerHour,

        averageTime:
            durations.length
                ? durations.reduce(
                      (
                          sum,
                          value
                      ) =>
                          sum + value,
                      0
                  ) /
                  durations.length
                : 0,

        p50: percentile(
            durations,
            0.50
        ),

        p90: percentile(
            durations,
            0.90
        ),

        p95: percentile(
            durations,
            0.95
        ),

        p99: percentile(
            durations,
            0.99
        )
    };
}

function padCell(
    value: unknown,
    width: number
): string {
    return String(
        value
    ).padEnd(
        width,
        ' '
    );
}

function printTable(
    headers: string[],
    rows: unknown[][],
    widths: number[] | null =
        null
): void {
    const allRows = [
        headers,
        ...rows
    ];

    const actualWidths =
        headers.map(
            (
                _,
                columnIndex
            ) => {
                const maxContentLength =
                    Math.max(
                        ...allRows.map(
                            (
                                row
                            ) =>
                                String(
                                    row[
                                        columnIndex
                                    ] ??
                                        ''
                                ).length
                        )
                    );

                const requestedWidth =
                    widths &&
                    Number.isFinite(
                        widths[
                            columnIndex
                        ]
                    )
                        ? widths[
                              columnIndex
                          ]
                        : 0;

                return Math.max(
                    maxContentLength,
                    requestedWidth
                );
            }
        );

    const top =
        `┌${actualWidths
            .map(
                (width) =>
                    '─'.repeat(
                        width + 2
                    )
            )
            .join('┬')}┐`;

    const middle =
        `├${actualWidths
            .map(
                (width) =>
                    '─'.repeat(
                        width + 2
                    )
            )
            .join('┼')}┤`;

    const bottom =
        `└${actualWidths
            .map(
                (width) =>
                    '─'.repeat(
                        width + 2
                    )
            )
            .join('┴')}┘`;

    console.log(top);

    console.log(
        `│ ${headers
            .map(
                (
                    header,
                    index
                ) =>
                    padCell(
                        header,
                        actualWidths[
                            index
                        ]
                    )
            )
            .join(' │ ')} │`
    );

    console.log(middle);

    for (
        const row of rows
    ) {
        console.log(
            `│ ${row
                .map(
                    (
                        cell,
                        index
                    ) =>
                        padCell(
                            cell,
                            actualWidths[
                                index
                            ]
                        )
                )
                .join(
                    ' │ '
                )} │`
        );
    }

    console.log(bottom);
}

function getRepeatRows(
    ipHistory: Map<
        string,
        number[]
    >
): unknown[][] {
    const rows: unknown[][] =
        [];

    for (
        const [
            ip,
            rotations
        ] of ipHistory.entries()
    ) {
        if (
            rotations.length <=
            1
        ) {
            continue;
        }

        const repetitionCount =
            rotations.length -
            1;

        const rotationLabels =
            rotations.map(
                (
                    rotation
                ) =>
                    rotation ===
                    0
                        ? 'Initial'
                        : String(
                              rotation
                          )
            );

        rows.push([
            ip,
            String(
                repetitionCount
            ),
            rotationLabels.join(
                ', '
            )
        ]);
    }

    if (
        !rows.length
    ) {
        return [
            [
                'No repeated IPs',
                '0',
                '-'
            ]
        ];
    }

    rows.sort(
        (a, b) =>
            Number(b[1]) -
            Number(a[1])
    );

    return rows;
}

function getDuplicateRecoveryRows(
    duplicateRecoveries:
        DuplicateRecovery[]
): unknown[][] {
    if (
        !duplicateRecoveries.length
    ) {
        return [
            [
                'No duplicate IPs detected',
                '-',
                '-'
            ]
        ];
    }

    return duplicateRecoveries.map(
        (item) => [
            String(
                item.rotation
            ),

            String(
                item.attempts
            ),

            formatDuration(
                item.additionalTimeMs
            )
        ]
    );
}

function printStatistics(
    state: PersistedState,
    now: number = Date.now()
): void {
    const results =
        state.results;

    const ipHistory =
        new Map(
            Object.entries(
                state.ipHistory
            )
        );

    const stats =
        getStatistics(
            results,
            ipHistory
        );

    console.log('');

    printTable(
        [
            'Metric',
            'Result'
        ],

        [
            [
                'Total requests',
                String(
                    stats.totalRequests
                )
            ],

            [
                'Successful rotations',
                String(
                    stats.successfulRotations
                )
            ],

            [
                'Failed rotations',
                String(
                    stats.failedRotations
                )
            ],

            [
                'Unique IP addresses',
                String(
                    stats.uniqueIps
                )
            ],

            [
                'Repeated IPs',
                String(
                    stats.repeatedIps
                )
            ],

            [
                'Repeated IP share',
                formatPercent(
                    stats.repeatedIpShare
                )
            ],

            [
                'Maximum new IPs per hour',
                stats.maxIpsPerHour >
                    0
                    ? String(
                          Math.round(
                              stats.maxIpsPerHour
                          )
                      )
                    : '-'
            ]
        ],

        [
            40,
            30
        ]
    );

    console.log('');

    printTable(
        [
            'Metric',
            'Result'
        ],

        [
            [
                'Time to first new IP after IP change request',
                formatDuration(
                    stats.firstNewIpTime
                )
            ],

            [
                'Next rotation request',
                state.intervalSeconds >
                    0
                    ? `After ${state.intervalSeconds} sec interval`
                    : 'Immediately after new IP'
            ],

            [
                'Average time to new IP',
                formatDuration(
                    stats.averageTime
                )
            ],

            [
                'P50',
                formatDuration(
                    stats.p50
                )
            ],

            [
                'P90',
                formatDuration(
                    stats.p90
                )
            ],

            [
                'P95',
                formatDuration(
                    stats.p95
                )
            ],

            [
                'P99',
                formatDuration(
                    stats.p99
                )
            ],

            [
                'Time since test start',
                formatElapsed(
                    now -
                        state.testStartedAt
                )
            ]
        ],

        [
            60,
            35
        ]
    );

    console.log('');

    if (
        state.mode ===
        'no-repeat'
    ) {
        printTable(
            [
                'Rotation',
                'Number of attempts',
                'Additional Change-IP'
            ],

            getDuplicateRecoveryRows(
                state.duplicateRecoveries
            ),

            [
                12,
                20,
                25
            ]
        );
    } else {
        printTable(
            [
                'IP Address',
                'Number of repetitions',
                'Rotations'
            ],

            getRepeatRows(
                ipHistory
            ),

            [
                20,
                22,
                36
            ]
        );
    }
}

function isFinished(
    state: PersistedState
): boolean {
    if (
        state.totalRotations ===
        'infinite'
    ) {
        return false;
    }

    return (
        state.completedRotations >=
        state.totalRotations
    );
}

function shouldPrintStatistics(
    rotation: number,
    state: PersistedState
): boolean {
    if (
        rotation %
            STATS_INTERVAL ===
        0
    ) {
        return true;
    }

    if (
        state.totalRotations !==
            'infinite' &&
        rotation ===
            state.totalRotations
    ) {
        return true;
    }

    return false;
}

async function waitInterval(
    state: PersistedState
): Promise<void> {
    if (
        state.intervalSeconds <=
        0
    ) {
        return;
    }

    await sleep(
        state.intervalSeconds *
            1000
    );
}

async function askHidden(
    question: string
): Promise<string> {
    return new Promise(
        (resolve) => {
            const stdin =
                process.stdin;

            process.stdout.write(
                question
            );

            stdin.setRawMode(
                true
            );

            stdin.resume();

            stdin.setEncoding(
                'utf8'
            );

            let answer = '';

            function onData(
                data: string
            ): void {
                for (
                    const char of data
                ) {
                    if (
                        char ===
                            '\r' ||
                        char ===
                            '\n'
                    ) {
                        stdin.setRawMode(
                            false
                        );

                        stdin.pause();

                        stdin.removeListener(
                            'data',
                            onData
                        );

                        process.stdout.write(
                            '\n'
                        );

                        resolve(
                            answer.trim()
                        );

                        return;
                    }

                    if (
                        char ===
                        '\u0003'
                    ) {
                        stdin.setRawMode(
                            false
                        );

                        stdin.pause();

                        stdin.removeListener(
                            'data',
                            onData
                        );

                        process.stdout.write(
                            '\n'
                        );

                        process.exit(
                            1
                        );
                    }

                    if (
                        char ===
                            '\u007f' ||
                        char ===
                            '\b'
                    ) {
                        if (
                            answer.length >
                            0
                        ) {
                            answer =
                                answer.slice(
                                    0,
                                    -1
                                );

                            process.stdout.write(
                                '\b \b'
                            );
                        }

                        continue;
                    }

                    if (
                        char >=
                            ' ' &&
                        char <=
                            '~'
                    ) {
                        answer +=
                            char;

                        process.stdout.write(
                            '*'
                        );
                    }
                }
            }

            stdin.on(
                'data',
                onData
            );
        }
    );
}

async function main(): Promise<void> {
    const args =
        parseArgs(
            process.argv.slice(
                2
            )
        );

    /*
     * Data deletion.
     */
    if (
        args.deleteData
    ) {
        if (
            args.changeIpUrl ||
            args.proxyUrl
        ) {
            throw new Error(
                '--delete-data cannot be used together with Change-IP URL or proxy.'
            );
        }

        await deleteDataFile(
            args.mode
        );

        return;
    }

    if (
        !args.changeIpUrl ||
        !args.proxyUrl
    ) {
        printUsage();

        process.exit(
            1
        );
    }

    const changeIpUrl =
        args.changeIpUrl;

    const proxyUrl =
        args.proxyUrl;

    const mode =
        args.mode;

    console.log('');

    console.log(
        `Change-IP: ${changeIpUrl}`
    );

    console.log(
        `SOCKS5: ${maskProxyUrl(
            proxyUrl
        )}`
    );

    console.log(
        `Rotations: ${args.rotations}`
    );

    if (
        args.intervalSeconds >
        0
    ) {
        console.log(
            `Interval: ${args.intervalSeconds} sec`
        );
    }

    if (
        mode ===
        'no-repeat'
    ) {
        console.log(
            `Mode: ${color(
                'NO-REPEAT',
                'cyan'
            )}`
        );
    }

    console.log('');

    const token =
        await askHidden(
            'Enter API token: '
        );

    if (!token) {
        console.error(
            'API token is required.'
        );

        process.exit(
            1
        );
    }

    console.log('');

    let state =
        await loadState(
            mode
        );

    /*
     * Continue an existing test.
     */
    if (state) {
        validateStateForRun(
            state,
            changeIpUrl,
            proxyUrl,
            args.rotations,
            args.intervalSeconds,
            args.intervalSpecified,
            args.rotationsSpecified
        );

        /*
         * IMPORTANT:
         *
         * If --rotations was not specified,
         * validateStateForRun() changes
         * totalRotations from the old completed
         * count to completedRotations + 1.
         *
         * Save it before checking isFinished().
         */
        await saveState(
            state
        );

        console.log(
            color(
                `Resuming saved test: ${state.completedRotations}/${state.totalRotations} rotations completed`,
                'cyan'
            )
        );
    } else {
        /*
         * First launch:
         * get the initial IP and create JSON state.
         */
        console.log(
            'Getting initial IP through SOCKS5...'
        );

        const initialResult =
            await getProxyIp(
                proxyUrl
            );

        if (
            !initialResult.success ||
            !initialResult.ip
        ) {
            console.error(
                `Failed to get initial IP: ${
                    initialResult.error ||
                    'unknown error'
                }`
            );

            process.exit(
                1
            );
        }

        state =
            createState(
                mode,
                changeIpUrl,
                proxyUrl,
                args.rotations,
                args.intervalSeconds,
                initialResult.ip
            );

        await saveState(
            state
        );

        console.log(
            `Initial IP: ${color(
                initialResult.ip,
                'cyan'
            )}`
        );
    }

    /*
     * This check is now performed only AFTER
     * validateStateForRun() has updated
     * totalRotations.
     */
    if (
        isFinished(state)
    ) {
        console.log(
            color(
                `Test already completed: ${state.completedRotations}/${state.totalRotations} rotations`,
                'green'
            )
        );

        printStatistics(
            state
        );

        return;
    }

    /*
     * Main rotation loop.
     */
    for (
        let rotation =
            state.completedRotations +
            1;

        state.totalRotations ===
            'infinite' ||
        rotation <=
            state.totalRotations;

        rotation++
    ) {
        /*
         * Interval is measured from successful
         * completion of the previous rotation
         * to the next Change-IP request.
         *
         * No interval before the first rotation.
         *
         * Duplicate recovery in --no-repeat
         * never uses this interval.
         */
        if (
            rotation >
            state.completedRotations +
                1
        ) {
            await waitInterval(
                state
            );
        }

        const previousIp =
            state.currentIp;

        const rotationStartedAt =
            Date.now();

        let additionalTimeMs =
            0;

        let attempts = 0;

        let duplicateFound =
            false;

        console.log('');

        console.log(
            color(
                `Rotation ${rotation}/${state.totalRotations}`,
                'bold'
            )
        );

        console.log(
            `Previous IP: ${previousIp}`
        );

        /*
         * In normal mode:
         * one Change-IP request per rotation.
         *
         * In no-repeat mode:
         * continue requesting Change-IP until
         * the returned IP was never seen before.
         */
        while (true) {
            attempts++;

            const attemptStartedAt =
                Date.now();

            console.log(
                'Sending IP change request'
            );

            const changeResult =
                await requestChangeIp(
                    changeIpUrl,
                    token
                );

            if (
                changeResult.retryLimitReached
            ) {
                const totalDuration =
                    Date.now() -
                    rotationStartedAt;

                state.results.push({
                    rotation,
                    success: false,
                    newIp: null,
                    durationMs:
                        totalDuration,
                    isRepeat: false,
                    successAt: null,
                    attempts
                });

                state.completedRotations =
                    rotation;

                await saveState(
                    state
                );

                console.log(
                    color(
                        'Rotation failed: router was not available within 30 sec',
                        'red'
                    )
                );

                break;
            }

            const rotationResult =
                await waitForNewIp(
                    proxyUrl,
                    previousIp,
                    attemptStartedAt
                );

            if (
                !rotationResult.success ||
                !rotationResult.newIp
            ) {
                const totalDuration =
                    Date.now() -
                    rotationStartedAt;

                state.results.push({
                    rotation,
                    success: false,
                    newIp: null,
                    durationMs:
                        totalDuration,
                    isRepeat: false,
                    successAt: null,
                    attempts
                });

                state.completedRotations =
                    rotation;

                await saveState(
                    state
                );

                console.log(
                    color(
                        'Rotation failed: new IP was not received within 5 minutes',
                        'red'
                    )
                );

                break;
            }

            const newIp =
                rotationResult.newIp;

            /*
             * IP was already seen previously.
             */
            const isRepeat =
                Object.prototype.hasOwnProperty.call(
                    state.ipHistory,
                    newIp
                );

            /*
             * NO-REPEAT:
             *
             * Do not finish the rotation.
             *
             * Request another IP immediately.
             */
            if (
                mode ===
                    'no-repeat' &&
                isRepeat
            ) {
                duplicateFound =
                    true;

                additionalTimeMs +=
                    Date.now() -
                    attemptStartedAt;

                console.log(
                    `New IP: ${color(
                        newIp,
                        'red'
                    )}`
                );

                console.log(
                    color(
                        'Duplicate IP detected. Requesting another IP...',
                        'red'
                    )
                );

                continue;
            }

            /*
             * Save the IP to history.
             *
             * Rotation 0 is the initial IP.
             */
            const previousRotations =
                state.ipHistory[
                    newIp
                ] ?? [];

            state.ipHistory[
                newIp
            ] = [
                ...previousRotations,
                rotation
            ];

            state.currentIp =
                newIp;

            const successAt =
                Date.now();

            const totalDuration =
                successAt -
                rotationStartedAt;

            state.results.push({
                rotation,
                success: true,
                newIp,
                durationMs:
                    totalDuration,
                isRepeat,
                successAt,
                attempts
            });

            state.completedRotations =
                rotation;

            /*
             * Save duplicate recovery information
             * only when a duplicate was encountered.
             */
            if (
                mode ===
                    'no-repeat' &&
                duplicateFound
            ) {
                state.duplicateRecoveries.push(
                    {
                        rotation,
                        attempts,
                        additionalTimeMs
                    }
                );
            }

            /*
             * Persist immediately after every
             * successfully completed rotation.
             */
            await saveState(
                state
            );

            console.log(
                `New IP: ${color(
                    newIp,
                    'green'
                )}`
            );

            console.log(
                `IP changed: ${color(
                    'Yes',
                    'green'
                )}`
            );

            console.log(
                `Change time: ${formatDuration(
                    totalDuration
                )}`
            );

            if (
                mode ===
                'no-repeat'
            ) {
                if (
                    duplicateFound
                ) {
                    console.log(
                        `Additional Change-IP time: ${formatDuration(
                            additionalTimeMs
                        )}`
                    );
                }

                console.log(
                    `New IP: ${color(
                        'Yes',
                        'green'
                    )}`
                );
            } else if (
                isRepeat
            ) {
                const firstRotation =
                    previousRotations[
                        0
                    ];

                const firstRotationLabel =
                    firstRotation ===
                    0
                        ? 'initial IP'
                        : `rotation ${firstRotation}`;

                console.log(
                    `New IP: ${color(
                        `No, repeated at ${firstRotationLabel}`,
                        'red'
                    )}`
                );
            } else {
                console.log(
                    `New IP: ${color(
                        'Yes',
                        'green'
                    )}`
                );
            }

            break;
        }

        /*
         * Statistics:
         *
         * - every 10 rotations
         * - at the end of a finite test
         * - every 10 rotations in infinite mode
         */
        if (
            shouldPrintStatistics(
                rotation,
                state
            )
        ) {
            console.log('');

            console.log(
                color(
                    `Statistics after ${rotation} rotations`,
                    'bold'
                )
            );

            printStatistics(
                state
            );
        }
    }

    /*
     * No separate FINAL STATISTICS block.
     */
    if (
        state.totalRotations !==
            'infinite' &&
        state.completedRotations >=
            state.totalRotations
    ) {
        console.log('');

        console.log(
            color(
                `Test completed: ${state.totalRotations} rotations`,
                'green'
            )
        );
    }
}

main().catch(
    (error: unknown) => {
        console.error('');

        console.error(
            color(
                `Critical error: ${
                    error instanceof Error
                        ? error.message
                        : String(error)
                }`,
                'red'
            )
        );

        process.exit(1);
    }
);