#!/bin/bash
BASE="http://file-manager.default.136.111.227.195.sslip.io"

echo "1. Initial load /cache-tests"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/cache-tests"

echo "2. RSC navigation to /cache-tests"
curl -s -o /dev/null -w "%{http_code}\n" -H "RSC: 1" -H "Next-Router-State-Tree: %5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D" -H "Next-Url: /cache-tests" "$BASE/cache-tests?_rsc=test"

echo "3. RSC navigation to /audit"
curl -s -o /dev/null -w "%{http_code}\n" -H "RSC: 1" -H "Next-Router-State-Tree: %5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D" -H "Next-Url: /audit" "$BASE/audit?_rsc=test"
