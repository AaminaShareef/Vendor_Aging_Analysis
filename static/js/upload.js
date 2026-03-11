/* upload.js – file selection, drag-and-drop, manual FormData submission */

(function () {
    // ── State: hold actual File objects ───────────────────────
    const fileMap = {
        bsik_file: null,
        lfa1_file: null,
        lfb1_file: null,
    };

    const slots = [
        { field: "bsik_file", dropId: "drop-bsik",  contentId: "drop-content-bsik" },
        { field: "lfa1_file", dropId: "drop-lfa1",  contentId: "drop-content-lfa1" },
        { field: "lfb1_file", dropId: "drop-lfb1",  contentId: "drop-content-lfb1" },
    ];

    // ── Wire up each slot ─────────────────────────────────────
    slots.forEach(({ field, dropId, contentId }) => {
        const input    = document.getElementById(field);
        const dropZone = document.getElementById(dropId);
        const contentEl = document.getElementById(contentId);

        function showFile(file) {
            fileMap[field] = file;
            dropZone.classList.add("file-selected");
            contentEl.classList.add("file-ok");
            contentEl.innerHTML =
                '<i class="fas fa-check-circle"></i>' +
                '<span style="word-break:break-all">' + file.name + '</span>' +
                '<small>Ready to upload</small>';
            updateRunBtn();
        }

        // Click on zone → open file picker
        dropZone.addEventListener("click", function () { input.click(); });

        // File picker selection
        input.addEventListener("change", function () {
            if (input.files && input.files[0]) showFile(input.files[0]);
        });

        // Drag events
        dropZone.addEventListener("dragover", function (e) {
            e.preventDefault();
            dropZone.style.borderColor = "rgba(61,127,255,0.9)";
            dropZone.style.background  = "rgba(61,127,255,0.07)";
        });
        dropZone.addEventListener("dragleave", function () {
            dropZone.style.borderColor = "";
            dropZone.style.background  = "";
        });
        dropZone.addEventListener("drop", function (e) {
            e.preventDefault();
            dropZone.style.borderColor = "";
            dropZone.style.background  = "";
            var f = e.dataTransfer.files[0];
            if (f) {
                try {
                    var dt = new DataTransfer();
                    dt.items.add(f);
                    input.files = dt.files;
                } catch (_) {}
                showFile(f);
            }
        });
    });

    // ── Run button / hint ──────────────────────────────────────
    var runBtn  = document.getElementById("runBtn");
    var runHint = document.getElementById("runHint");

    function updateRunBtn() {
        var missing = Object.values(fileMap).filter(function (v) { return !v; }).length;
        if (missing === 0) {
            runHint.textContent = "All 3 files ready — click to run analysis.";
            runHint.style.color = "var(--risk-low)";
        } else {
            runHint.textContent = missing + " file" + (missing > 1 ? "s" : "") + " still needed.";
            runHint.style.color = "";
        }
    }

    // ── UI elements ───────────────────────────────────────────
    var overlay     = document.getElementById("progressOverlay");
    var progressBar = document.getElementById("progressBar");
    var progressMsg = document.getElementById("progressMsg");
    var errorBanner = document.getElementById("errorBanner");
    var errorMsgEl  = document.getElementById("errorMsg");

    var STEPS = [
        [8,   "Loading SAP data files..."],
        [22,  "Normalising column names & remapping..."],
        [38,  "Computing invoice aging buckets..."],
        [52,  "Aggregating vendor overdue metrics..."],
        [65,  "Calculating composite risk scores..."],
        [76,  "Running K-Means vendor clustering..."],
        [89,  "Training Random Forest classifier..."],
        [96,  "Building result payload..."],
        [100, "Analysis complete — preparing dashboard..."],
    ];

    function showError(msg) {
        errorMsgEl.textContent = msg;
        errorBanner.style.display = "flex";
        errorBanner.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // ── Click handler ──────────────────────────────────────────
    runBtn.addEventListener("click", async function () {
        // Validate all files present
        var missing = slots
            .filter(function (s) { return !fileMap[s.field]; })
            .map(function (s) { return s.field.replace("_file", "").toUpperCase(); });

        if (missing.length > 0) {
            showError("Please select all 3 CSV files. Still missing: " + missing.join(", "));
            return;
        }

        // Validate CSV extension
        for (var field in fileMap) {
            if (!fileMap[field].name.toLowerCase().endsWith(".csv")) {
                showError('"' + fileMap[field].name + '" is not a CSV file.');
                return;
            }
        }

        // Start progress UI
        errorBanner.style.display = "none";
        overlay.style.display = "flex";
        runBtn.disabled = true;
        progressBar.style.width = "0%";

        var stepIdx = 0;
        var stepInterval = setInterval(function () {
            if (stepIdx < STEPS.length - 1) {
                progressBar.style.width = STEPS[stepIdx][0] + "%";
                progressMsg.textContent  = STEPS[stepIdx][1];
                stepIdx++;
            } else {
                clearInterval(stepInterval);
            }
        }, 700);

        // Build FormData from stored File objects
        var fd = new FormData();
        fd.append("bsik_file", fileMap["bsik_file"]);
        fd.append("lfa1_file", fileMap["lfa1_file"]);
        fd.append("lfb1_file", fileMap["lfb1_file"]);

        try {
            var res  = await fetch("/analyze", { method: "POST", body: fd });
            clearInterval(stepInterval);
            var json = await res.json();

            if (!res.ok || json.error) {
                throw new Error(json.error || ("Server error " + res.status));
            }

            progressBar.style.width = "100%";
            progressMsg.textContent = "Analysis complete! Redirecting to dashboard...";
            setTimeout(function () { window.location.href = "/results"; }, 900);

        } catch (err) {
            clearInterval(stepInterval);
            overlay.style.display = "none";
            runBtn.disabled = false;
            showError(err.message || "An unexpected error occurred.");
        }
    });
})();