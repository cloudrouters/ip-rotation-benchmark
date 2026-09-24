# IP Rotation Benchmark for a Dedicated Modem

A tool for testing the number of repeated IP addresses and the speed at which an Internet service provider assigns IP addresses through a dedicated modem.

## How the IP Rotation Test Works

For each rotation, the program:

1. Saves the current IP address;
2. Sends an API `change IP` request;
3. Waits for a new IP address from the Internet service provider;
4. Checks the received IP address through SOCKS5;
5. Compares it with the previous IP address;
6. Saves the result;
7. Moves to the next rotation.

In normal mode, a repeated IP address is recorded as a repeat.

In `--no-repeat` mode, when a repeated IP is detected, an additional `change IP` request is performed until an IP address that has not appeared in the test history is received.

## Installation

1. Download the repository: **Code / Download ZIP**
2. Extract the archive.
3. Download and install Node.js: https://nodejs.org/en/download
4. Open the repository directory in your operating system's console (CMD or another terminal).
5. Install the dependencies:

```bash
npm install
```

## Quick Start

To perform one rotation and obtain a unique IP address that has never been previously assigned by the Internet service provider:

```bash
npm run rotation -- "https://cloud-routers.com/api/v1/ports/id/change-ip" "socks5://login:pass@ip:port" --no-repeat
```

After starting, the program will ask for the **API key**.

The API key is entered securely and is not displayed on the screen.

## Example Output

<pre>
<b>Rotation 1/1</b>
Previous IP: 188.28.90.112
Sending IP change request
New IP: <span style="color:#32CD32">188.28.70.140</span>
IP changed: <span style="color:#32CD32"><b>Yes</b></span>
Change time: 38.7 sec
New IP: <span style="color:#32CD32"><b>Yes</b></span>
</pre>

## Parameters

General command format:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" [OPTIONS]
```

Without additional parameters, one rotation is performed:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY"
```

Each rotation performs one `change IP` request and checks the resulting IP address.

If the received IP has already appeared previously, it is recorded as a repeated IP, but it is not discarded. The rotation simply continues.

This allows you to see the actual repeat rate during sequential IP rotations.

If the test has already been run before, the next rotation is added to the saved results.

### `--no-repeat`

Use the `--no-repeat` parameter to enable this mode:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --no-repeat
```

A repeated IP is not considered a successful rotation result.

If the received IP has already appeared previously, the program automatically performs an additional `change IP` request and checks the IP again.

This process continues until a new unique IP address is received.

Additional attempts are not counted as separate rotations and are recorded separately in the statistics.

### `--rotations=NUMBER`

Specifies the number of rotations to be performed automatically:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --rotations=100
```

If 40 rotations have already been completed and the test was stopped, running the test with `--rotations=100` will continue from rotation 41 and finish after rotation 100.

Can be combined with `--no-repeat`:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --rotations=100 --no-repeat
```

### `--rotations=infinite`

Starts an infinite rotation loop:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --rotations=infinite
```

The test can be stopped with `Ctrl+C` and continued later using the same command.

Can be combined with `--no-repeat`:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --rotations=infinite --no-repeat
```

### `--interval=SECONDS`

Specifies the delay between successfully completed rotations in seconds:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --rotations=100 --interval=30
```

Can be combined with `--no-repeat`:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --rotations=100 --no-repeat --interval=30
```

It can also be used with an infinite test:

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --rotations=infinite --interval=30
```

```bash
npm run rotation -- "CHANGE-IP-URL" "SOCKS5-PROXY" --rotations=infinite --no-repeat --interval=30
```

When a repeated IP is detected in `--no-repeat` mode, additional `change IP` requests are performed within the same rotation. The `--interval` delay is not applied between these additional attempts.

## Saving and Resuming

Results are automatically saved after each completed rotation.

Separate files are used:

```text
rotation-results.json
rotation-results-no-repeat.json
```

This allows you to:

* stop the test and continue it later;
* avoid losing results when the program is terminated;
* run the test in multiple parts;
* use separate saved states for normal mode and `--no-repeat`.

When the program is started again, it continues the existing test from the last saved rotation.

For example:

```text
100 rotations planned
        ↓
40 rotations completed
        ↓
test stopped
        ↓
test started again
        ↓
continues from rotation 41
```

Saved results are associated with the `change IP` URL and SOCKS5 proxy being used.

If the URL or SOCKS5 proxy has changed, the saved test is not used as a continuation of the new test. In this case, the old data can be deleted using `--delete-data`.

## Deleting Results

Each mode uses a separate results file.

Delete data for normal mode:

```bash
npm run rotation -- --delete-data
```

Delete data for `--no-repeat` mode:

```bash
npm run rotation -- --delete-data --no-repeat
```

After the corresponding file is deleted, the next run starts a new test by obtaining the initial IP address.

For example:

```text
rotation-results.json
        ↓
--delete-data
        ↓
old test deleted
        ↓
next run starts from the beginning
```

Deleting the data for one mode does not delete the results of the other mode.

## Statistics

After each series of rotations, the program displays statistics.

### Main Statistics

| **Metric**               | **Result** |
| ------------------------ | ---------: |
| Total requests           |        500 |
| Successful rotations     |        500 |
| Failed rotations         |          0 |
| Unique IP addresses      |        501 |
| Repeated IPs             |          0 |
| Repeated IP share        |         0% |
| Maximum new IPs per hour |        102 |

**Total requests** — the number of completed rotations.

**Successful rotations** — the number of rotations completed without an error.

**Failed rotations** — the number of rotations that ended with an error.

**Unique IP addresses** includes the initial IP address. Therefore, 500 successful rotations without repeats result in 501 unique IP addresses.

**Repeated IPs** — the number of received IP addresses that had already appeared previously.

**Repeated IP share** — the percentage of repeated IP addresses among all completed rotations.

**Maximum new IPs per hour** — the estimated rate of obtaining new IP addresses per hour, based on the average interval between successful rotations.

### Rotation Time

| **Metric**                                   |               **Result** |
| -------------------------------------------- | -----------------------: |
| Time to first new IP after IP change request |                 34.4 sec |
| Next rotation request                        | Immediately after new IP |
| Average time to new IP                       |                 38.6 sec |
| P50                                          |                        — |
| P90                                          |                        — |
| P95                                          |                        — |
| P99                                          |                        — |
| Time since test start                        |                        — |

**Time to first new IP after IP change request** — the time from the Change-IP request until a new IP address is received.

**Next rotation request** — when the next Change-IP request is performed after receiving a new IP.

**Average time to new IP** — the average time required to obtain a new IP address.

**P50 / P90 / P95 / P99** — percentile distribution of the time required to obtain a new IP address.

**Time since test start** — the time elapsed since the beginning of the current saved test.

### Repeated IP Address Statistics

In normal mode, the program displays a list of IP addresses that appeared repeatedly:

| **IP Address** | **Number of repetitions** | **Rotations**                        |
| -------------- | ------------------------: | ------------------------------------ |
| 188.28.80.159  |                         8 | 41, 120, 194, 224, 264, 290, 342, 38 |
| …              |                         … | …                                    |

**IP Address** — the IP address that appeared repeatedly.

**Number of repetitions** — how many times this IP appeared again during the test.

**Rotations** — the rotation numbers on which this IP was received.

If there are no repeats:

```text
No repeated IPs
```

In `--no-repeat` mode, instead of a list of repeated IP addresses, the program displays information about rotations where additional `change IP` requests were required to obtain a unique IP address:

| **Rotation** | **Number of attempts** | **Additional Change-IP** |
| ------------ | ---------------------: | -----------------------: |
| 54           |                      2 |                 68.5 sec |
| …            |                      … |                        … |

**Rotation** — the rotation number.

**Number of attempts** — the total number of attempts to obtain a unique IP within this rotation.

**Additional Change-IP** — the time spent on additional attempts after a repeated IP was detected.

For example:

```text
Rotation: 54
Number of attempts: 2
```

In this case, the first attempt received a repeated IP, while the second attempt received a new IP.

## API Key

The API key is created in the personal account:

https://cloud-routers.com/app/apikeys

The API key is entered separately after starting the program and is not stored in the saved results.

