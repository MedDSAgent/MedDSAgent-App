// --- State & Layout ---
let currentSessionId = null;
let layout = null;
let isDarkMode = true;
let currentAbortController = null; // For canceling streams
let isGenerating = false;

// --- Terminal State ---
const terminals = {};          // terminalId → { xterm, fitAddon, ws, containerEl, tabEl, title, sessionId }
let activeTerminalId = null;
let terminalComponentReady = false; // true once the Terminal GL panel has been mounted
let currentSessionName = null;     // human-readable name of the active session
let sessionsCache = [];            // last sessions list from API, used for name lookups

// --- Smart Scroll Logic ---
let isUserAtBottom = true; // Default to true so it scrolls initially

// --- Editor State ---
let aceEditor = null;            // Ace Editor instance
let currentFilePath = null;      // Currently open file path
let originalContent = null;      // Original content to detect changes
let isEditorDirty = false;       // Has unsaved changes

// --- Specialty Editor State ---
let specialtyAce = null;         // Ace Editor for specialty prompt (inline)
let specialtyExpandAce = null;   // Ace Editor for specialty prompt (expand modal)
let specialtyIndex = null;       // Cached specialty index from API
let specialtySetProgrammatic = false; // Guard: true when setValue() is called programmatically

// Highlight a single code block safely — skips blocks already processed by hljs
// to avoid the "Element previously highlighted" console error.
function safeHighlight(block) {
    if (!block.dataset.highlighted) hljs.highlightElement(block);
}

// --- Theme Logic ---
function toggleTheme() {
    isDarkMode = !isDarkMode;
    document.body.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
    
    const icon = document.getElementById('theme-icon');
    icon.className = isDarkMode ? 'fas fa-moon' : 'fas fa-sun';
    
    const closeBtn = document.querySelector('.btn-close');
    if(closeBtn) {
        if(isDarkMode) closeBtn.classList.add('btn-close-white');
        else closeBtn.classList.remove('btn-close-white');
    }

    const hljsTheme = document.getElementById('hljs-theme');
    if (hljsTheme) {
        const darkThemeUrl = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css";
        const lightThemeUrl = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css";
        hljsTheme.href = isDarkMode ? darkThemeUrl : lightThemeUrl;
    }

    // Update Ace Editor theme if active
    if (aceEditor) {
        aceEditor.setTheme(isDarkMode ? 'ace/theme/monokai' : 'ace/theme/chrome');
    }
    if (specialtyAce) {
        specialtyAce.setTheme(isDarkMode ? 'ace/theme/monokai' : 'ace/theme/chrome');
    }
    if (specialtyExpandAce) {
        specialtyExpandAce.setTheme(isDarkMode ? 'ace/theme/monokai' : 'ace/theme/chrome');
    }
}

// --- Initialization ---
$(document).ready(function () {
    const config = {
        settings: {
            showPopoutIcon: false,
            showCloseIcon: false,
            hasHeaders: true
        },
        dimensions: { headerHeight: 25, borderWidth: 4 },
        content: [{
            type: 'row',
            content: [
                { type: 'component', componentName: 'Sidebar', width: 20, isClosable: false },
                {
                    type: 'stack',
                    width: 55,
                    content: [
                        { type: 'component', componentName: 'Chat', title: 'Chat', isClosable: false },
                        { type: 'component', componentName: 'Editor', title: 'Editor', isClosable: false },
                        { type: 'component', componentName: 'FileViewer', title: 'Viewer', isClosable: false }
                    ]
                },
                {
                    type: 'column',
                    width: 25,
                    content: [
                        { type: 'component', componentName: 'Environment', height: 40, isClosable: false },
                        {
                            type: 'stack',
                            height: 60,
                            content: [
                                { type: 'component', componentName: 'Workspace', title: 'Workspace', isClosable: false },
                                { type: 'component', componentName: 'Terminal', title: 'Terminal', isClosable: false }
                            ]
                        }
                    ]
                }
            ]
        }]
    };

    layout = new GoldenLayout(config, $('#layoutContainer'));

    ['Sidebar', 'Chat', 'Editor', 'Environment', 'Workspace', 'Terminal', 'FileViewer'].forEach(name => {
        layout.registerComponent(name, function(container) {
            if(name === 'Environment') container.getElement().html($('#tpl-env').html());
            else if(name === 'Workspace') container.getElement().html($('#tpl-files').html());
            else if(name === 'Chat') container.getElement().html($('#tpl-chat').html());
            else if(name === 'Sidebar') container.getElement().html($('#tpl-sidebar').html());
            else if(name === 'Editor') container.getElement().html($('#tpl-editor').html());
            else if(name === 'Terminal') container.getElement().html($('#tpl-terminal').html());
            else if(name === 'FileViewer') container.getElement().html($('#tpl-fileviewer').html());

            // Add Scroll Listener to Chat Component
            if(name === 'Chat') {
                setTimeout(() => {
                    const chatHistory = document.getElementById('chat-history');
                    if(chatHistory) {
                        chatHistory.addEventListener('scroll', () => {
                            const threshold = 30; // pixels from bottom to be considered "at bottom"
                            isUserAtBottom = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight <= threshold;
                        });
                    }
                }, 500); // Wait for layout init
            }

            // Initialize Editor when component is created
            if(name === 'Editor') {
                setTimeout(() => initEditorBindings(), 100);
            }

            // Initialize Terminal panel when component is created
            if(name === 'Terminal') {
                setTimeout(() => initTerminalPanel(container), 100);
            }
        });
    });

    layout.init();
    $(window).resize(() => layout.updateSize());

    loadSessions();

    $(document).on('input', '#user-input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    $(document).on('keydown', '#user-input', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    $(document).on('click', '#send-btn', sendMessage);
    $(document).on('click', '#openCreateSessionBtn', () => openSessionDialog(null));

    // Session list — use event delegation so data-* attributes are read at
    // click time (avoids any inline-JS quoting issues with special chars).
    $(document).on('click', '#session-list .session-item', function(e) {
        if ($(e.target).closest('.session-config, .session-delete').length) return;
        // Use dataset directly — jQuery 1.x .data() is unreliable on
        // dynamically-created elements for reading data-* attributes.
        selectSession(this.dataset.sessionId, this.dataset.sessionName);
    });
    $('#saveSessionBtn').click(handleSaveSession);
    
    // File Handlers
    $(document).on('click', '#upload-btn', () => $('#file-input').click());
    $(document).on('change', '#file-input', (e) => uploadFilesFromInput(e.target.files, "uploads"));
    $(document).on('click', '#refresh-files', () => loadFiles()); // Reload Root
    
    // Config Visibility Logic
    $('#llmProviderSelect').change(updateConfigVisibility);

    // Language switch: show/hide DB connection section
    $(document).on('change', 'input[name="language"]', updateLanguageVisibility);

    // Test DB Connection Button
    $(document).on('click', '#testConnectionBtn', testDbConnection);

    // Specialty dropdown change
    $(document).on('change', '#specialtySelect', handleSpecialtyChange);

    // Specialty expand button
    $(document).on('click', '#specialtyExpandBtn', openSpecialtyExpandModal);

    // Specialty expand modal apply
    $('#specialtyExpandApplyBtn').click(applySpecialtyExpand);

    // Specialty expand modal preview toggle
    $(document).on('click', '#specialtyPreviewToggle', toggleSpecialtyPreview);

});

function updateConfigVisibility() {
    const provider = $('#llmProviderSelect').val();
    $('.conditional-options').hide();

    if (provider === 'openai') $('#openai-options').show();
    else if (provider === 'azure') $('#azure-options').show();
    else if (['vllm', 'sglang', 'openrouter'].includes(provider)) $('#generic-options').show();
}

function updateLanguageVisibility() {
    const lang = $('input[name="language"]:checked').val();
    const label = $('#dbConnectionLabel');
    const hint = $('#dbConnectionHint');
    const textarea = $('#dbConnectionCodeInput');

    if (lang === 'r') {
        label.text('R Connection Code');
        hint.html('Write R code that creates a DBI connection object (e.g. <code>con</code>).');
        textarea.attr('placeholder',
            '# DBI + RPostgres\nlibrary(DBI)\ncon <- dbConnect(RPostgres::Postgres(),\n  host = "localhost", port = 5432,\n  dbname = "mydatabase",\n  user = "scott", password = "tiger")\n\n# DBI + RMySQL\ncon <- dbConnect(RMySQL::MySQL(),\n  host = "localhost", dbname = "mydatabase",\n  user = "scott", password = "tiger")\n\n# DBI + RSQLite\ncon <- dbConnect(RSQLite::SQLite(), "mydatabase.db")\n\n# DBI + odbc\ncon <- dbConnect(odbc::odbc(),\n  Driver = "ODBC Driver 17 for SQL Server",\n  Server = "localhost",\n  Database = "mydatabase",\n  UID = "scott", PWD = "tiger")'
        );
    } else {
        label.text('Python Connection Code');
        hint.html('Write Python code that creates either <code>db_engine</code> (SQLAlchemy) or <code>conn</code> (direct connection).');
        textarea.attr('placeholder',
            '# SQLAlchemy\nfrom sqlalchemy import create_engine\n\n# PostgreSQL\ndb_engine = create_engine(\'postgresql://scott:tiger@localhost:5432/mydatabase\')\n\n# MySQL\ndb_engine = create_engine(\'mysql+pymysql://scott:tiger@localhost:3306/mydatabase\')\n\n# SQLite\ndb_engine = create_engine(\'sqlite:///mydatabase.db\')\n\n# Direct connection (oracledb)\nimport oracledb\nconn = oracledb.connect(user=\'scott\', password=\'tiger\', dsn=\'localhost:1521/orclpdb1\')'
        );
    }
}

async function testDbConnection() {
    const code = $('#dbConnectionCodeInput').val();
    const resultSpan = $('#connectionTestResult');
    const btn = $('#testConnectionBtn');

    if (!code || !code.trim()) {
        resultSpan.removeClass('text-success text-danger').addClass('text-warning').text('No connection code provided');
        return;
    }

    // Show loading state
    btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> Testing...');
    resultSpan.removeClass('text-success text-danger text-warning').text('');

    try {
        const res = await fetch('/test-db-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code })
        });

        const data = await res.json();

        if (res.ok) {
            resultSpan.removeClass('text-danger text-warning').addClass('text-success')
                .html('<i class="fas fa-check-circle"></i> ' + data.message);
        } else {
            resultSpan.removeClass('text-success text-warning').addClass('text-danger')
                .html('<i class="fas fa-times-circle"></i> ' + (data.detail || 'Connection failed'));
        }
    } catch (e) {
        resultSpan.removeClass('text-success text-warning').addClass('text-danger')
            .html('<i class="fas fa-times-circle"></i> Network error: ' + e.message);
    } finally {
        btn.prop('disabled', false).html('<i class="fas fa-plug"></i> Test Connection');
    }
}

// --- Specialty Prompt Logic ---

async function loadSpecialtyIndex() {
    if (specialtyIndex !== null) return specialtyIndex;
    try {
        const res = await fetch('/specialty-prompts');
        specialtyIndex = await res.json();
    } catch(e) {
        console.error("Failed to load specialty index:", e);
        specialtyIndex = [];
    }
    return specialtyIndex;
}

function populateSpecialtyDropdown(selectedId) {
    const select = $('#specialtySelect');
    // Remove old dynamic options (keep none + custom)
    select.find('option').not('[value="none"],[value="custom"]').remove();

    if (specialtyIndex && specialtyIndex.length > 0) {
        specialtyIndex.forEach(entry => {
            select.append(`<option value="${entry.id}">${entry.display_name}</option>`);
        });
    }

    select.val(selectedId || 'none');
}

async function handleSpecialtyChange() {
    const id = $('#specialtySelect').val();
    if (id === 'none') {
        specialtySetProgrammatic = true;
        if (specialtyAce) specialtyAce.setValue('', -1);
        specialtySetProgrammatic = false;
        return;
    }
    if (id === 'custom') {
        // Leave editor content as-is for user to type
        if (specialtyAce) specialtyAce.focus();
        return;
    }
    // Fetch pre-defined specialty prompt
    try {
        const res = await fetch(`/specialty-prompts/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error("Failed to fetch specialty prompt");
        const data = await res.json();
        specialtySetProgrammatic = true;
        if (specialtyAce) specialtyAce.setValue(data.content, -1);
        specialtySetProgrammatic = false;
    } catch(e) {
        console.error("Error loading specialty prompt:", e);
        specialtySetProgrammatic = false;
    }
}

function initSpecialtyAceEditor() {
    // Destroy existing if present
    if (specialtyAce) {
        specialtyAce.destroy();
        specialtyAce = null;
    }

    const container = document.getElementById('specialtyAceEditor');
    if (!container) return;

    specialtyAce = ace.edit(container);
    specialtyAce.session.setMode('ace/mode/markdown');
    specialtyAce.setTheme(isDarkMode ? 'ace/theme/monokai' : 'ace/theme/chrome');
    specialtyAce.setOptions({
        fontSize: '13px',
        showPrintMargin: false,
        wrap: true,
        tabSize: 2,
        useSoftTabs: true,
        placeholder: 'e.g., You are a clinical data analyst specializing in oncology research...'
    });

    // When user edits text manually, switch dropdown to "custom" if it was a pre-defined one
    specialtyAce.session.on('change', () => {
        if (specialtySetProgrammatic) return;
        const currentSelect = $('#specialtySelect').val();
        if (currentSelect !== 'none' && currentSelect !== 'custom') {
            $('#specialtySelect').val('custom');
        }
    });
}

function openSpecialtyExpandModal() {
    const expandModal = new bootstrap.Modal(document.getElementById('specialtyExpandModal'));

    // Initialize expand Ace editor
    if (specialtyExpandAce) {
        specialtyExpandAce.destroy();
        specialtyExpandAce = null;
    }

    // Small delay to let modal render, then init editor
    const modalEl = document.getElementById('specialtyExpandModal');
    const initEditor = () => {
        specialtyExpandAce = ace.edit('specialtyExpandAceEditor');
        specialtyExpandAce.session.setMode('ace/mode/markdown');
        specialtyExpandAce.setTheme(isDarkMode ? 'ace/theme/monokai' : 'ace/theme/chrome');
        specialtyExpandAce.setOptions({
            fontSize: '14px',
            showPrintMargin: false,
            wrap: true,
            tabSize: 2,
            useSoftTabs: true
        });

        // Copy content from inline editor
        const content = specialtyAce ? specialtyAce.getValue() : '';
        specialtyExpandAce.setValue(content, -1);
        specialtyExpandAce.focus();

        modalEl.removeEventListener('shown.bs.modal', initEditor);
    };
    modalEl.addEventListener('shown.bs.modal', initEditor);

    // Reset preview state on open
    $('#specialtyExpandPreview').hide();
    $('#specialtyExpandAceEditor').show();
    $('#specialtyPreviewToggle').removeClass('active').html('<i class="fas fa-eye me-1"></i>Preview');
    $('#specialtyExpandApplyBtn').prop('disabled', false);

    // Clean up on hide
    const cleanup = () => {
        if (specialtyExpandAce) {
            specialtyExpandAce.destroy();
            specialtyExpandAce = null;
        }
        modalEl.removeEventListener('hidden.bs.modal', cleanup);
    };
    modalEl.addEventListener('hidden.bs.modal', cleanup);

    expandModal.show();
}

function toggleSpecialtyPreview() {
    const btn = $('#specialtyPreviewToggle');
    const editorEl = $('#specialtyExpandAceEditor');
    const previewEl = $('#specialtyExpandPreview');
    const applyBtn = $('#specialtyExpandApplyBtn');
    const isPreview = btn.hasClass('active');

    if (isPreview) {
        // Switch back to editor
        previewEl.hide();
        editorEl.show();
        if (specialtyExpandAce) specialtyExpandAce.resize();
        btn.removeClass('active').html('<i class="fas fa-eye me-1"></i>Preview');
    } else {
        // Switch to preview
        const content = specialtyExpandAce ? specialtyExpandAce.getValue() : '';
        previewEl.html(marked.parse(content));
        previewEl.find('pre code').each((i, block) => safeHighlight(block));
        editorEl.hide();
        previewEl.show();
        btn.addClass('active').html('<i class="fas fa-edit me-1"></i>Edit');
    }
}

function applySpecialtyExpand() {
    if (specialtyExpandAce && specialtyAce) {
        specialtySetProgrammatic = true;
        const content = specialtyExpandAce.getValue();
        specialtyAce.setValue(content, -1);
        specialtySetProgrammatic = false;
    }
    const modalEl = document.getElementById('specialtyExpandModal');
    const modal = bootstrap.Modal.getInstance(modalEl);
    if (modal) modal.hide();
}

// --- API Interactions ---

async function loadSessions() {
    try {
        const res = await fetch('/sessions');
        const sessions = await res.json();
        sessionsCache = sessions;   // keep for name lookups in selectSession
        const list = $('#session-list');
        list.empty();
        
        if(sessions.length === 0) {
            list.html('<div class="text-center text-muted mt-3 small">No sessions yet.</div>');
            return;
        }

        sessions.forEach(s => {
            const activeClass = s.session_id === currentSessionId ? 'active' : '';
            const date = new Date(s.last_accessed).toLocaleDateString();
            list.append(`
                <div class="session-item ${activeClass}"
                     data-session-id="${s.session_id}"
                     data-session-name="${escapeHtml(s.name)}">
                    <div style="flex-grow: 1;">
                        <div class="fw-bold">${s.name}</div>
                        <div class="session-meta">${date}</div>
                    </div>
                    <div class="d-flex align-items-center">
                        <i class="fas fa-cog session-config me-2" onclick="openSessionConfig(event, '${s.session_id}')" ></i>
                        <i class="fas fa-trash session-delete" onclick="deleteSession(event, '${s.session_id}')" ></i>
                    </div>
                </div>
            `);
        });
    } catch(e) { console.error(e); }
}

async function openSessionConfig(e, id) {
    e.stopPropagation();
    openSessionDialog(id);
}

async function openSessionDialog(sessionId) {
    const modal = new bootstrap.Modal(document.getElementById('sessionDialog'));
    const form = document.getElementById('sessionForm');

    // Reset Form
    form.reset();
    document.getElementById('sessionIdInput').value = "";
    $('#connectionTestResult').removeClass('text-success text-danger text-warning').text('');

    // Reset to first tab (Session)
    $('#sessionConfigTabs button:first').tab('show');

    // Set default common params
    document.getElementById('temperatureInput').value = "1.0";
    document.getElementById('topPInput').value = "1.0";
    document.getElementById('reasoningEffortSelect').value = "not_applicable";

    // Initialize specialty editor and dropdown
    await loadSpecialtyIndex();
    populateSpecialtyDropdown('none');
    initSpecialtyAceEditor();
    specialtySetProgrammatic = true;
    if (specialtyAce) specialtyAce.setValue('', -1);
    specialtySetProgrammatic = false;

    // Reset language selection to default (Python, enabled)
    $('#langPython').prop('checked', true);
    $('input[name="language"]').prop('disabled', false);
    $('#languageLockHint').hide();

    if (sessionId) {
        // Edit Mode
        document.getElementById('sessionDialogTitle').innerText = "Session Configuration";
        document.getElementById('saveSessionBtn').innerText = "Save";

        try {
            const res = await fetch(`/sessions/${sessionId}`);
            if(!res.ok) throw new Error("Failed to load session info");
            const data = await res.json();

            // Populate Fields
            document.getElementById('sessionIdInput').value = data.session_id;
            document.getElementById('sessionNameInput').value = data.name;

            const conf = data.config || {};
            const provider = conf.llm_provider || 'openai';
            $('#llmProviderSelect').val(provider);

            // Populate Sampling Params
            if(conf.temperature !== undefined) document.getElementById('temperatureInput').value = conf.temperature;
            if(conf.top_p !== undefined) document.getElementById('topPInput').value = conf.top_p;

            // Populate language and lock it (cannot change after creation)
            const language = conf.language || 'python';
            if (language === 'r') {
                $('#langR').prop('checked', true);
            } else {
                $('#langPython').prop('checked', true);
            }
            $('input[name="language"]').prop('disabled', true);
            $('#languageLockHint').show();

            // Populate specific fields based on key naming convention in HTML
            if(provider === 'openai') {
                $('[name="llm_model"]').val(conf.llm_model);
                $('[name="llm_api_key"]').val(conf.llm_api_key);
                // No base_url for OpenAI
            } else if (provider === 'azure') {
                $('[name="llm_model_azure"]').val(conf.llm_model);
                $('[name="llm_api_version"]').val(conf.llm_api_version);
                $('[name="llm_base_url_azure"]').val(conf.llm_base_url);
                $('[name="llm_api_key_azure"]').val(conf.llm_api_key);
            } else if (['vllm', 'sglang', 'openrouter'].includes(provider)) {
                $('[name="llm_model_generic"]').val(conf.llm_model);
                $('[name="llm_api_key_generic"]').val(conf.llm_api_key);
                $('[name="llm_base_url_generic"]').val(conf.llm_base_url);
            }

            if(conf.db_connection_code) {
                document.getElementById('dbConnectionCodeInput').value = conf.db_connection_code;
            }

            // Populate reasoning effort
            if(conf.reasoning_effort) {
                document.getElementById('reasoningEffortSelect').value = conf.reasoning_effort;
            }

            // Populate specialty dropdown and prompt
            if(conf.specialty_id) {
                populateSpecialtyDropdown(conf.specialty_id);
            } else if(conf.specialty_prompt) {
                populateSpecialtyDropdown('custom');
            }
            if(conf.specialty_prompt && specialtyAce) {
                specialtySetProgrammatic = true;
                specialtyAce.setValue(conf.specialty_prompt, -1);
                specialtySetProgrammatic = false;
            }
        } catch(e) {
            alert(e.message);
            return;
        }
    } else {
        // Create Mode
        document.getElementById('sessionDialogTitle').innerText = "New Session";
        document.getElementById('saveSessionBtn').innerText = "Create";
        document.getElementById('sessionNameInput').value = "Analysis #" + (Math.floor(Math.random() * 1000));
        $('#llmProviderSelect').val('openai');
    }

    updateConfigVisibility();
    updateLanguageVisibility();
    modal.show();
}

async function handleSaveSession() {
    const form = document.getElementById('sessionForm');
    const formData = new FormData(form);
    const sessionId = formData.get('session_id');
    const provider = formData.get('llm_provider');
    
    // Helper to get null for empty strings
    const getValueOrNull = (key) => {
        const val = formData.get(key);
        return val && val.trim() !== "" ? val.trim() : null;
    };

    // Extract standard config structure from dynamic fields
    let config = {
        llm_provider: provider,
        llm_model: "",
        llm_api_key: null,
        llm_base_url: null
    };

    // Add Sampling Params
    const tempVal = formData.get('temperature');
    const topPVal = formData.get('top_p');
    config.temperature = tempVal ? parseFloat(tempVal) : 1.0;
    config.top_p = topPVal ? parseFloat(topPVal) : 1.0;

    if (provider === 'openai') {
        config.llm_model = getValueOrNull('llm_model');
        config.llm_api_key = getValueOrNull('llm_api_key');
        config.llm_base_url = null; // Strictly null for OpenAI
    } else if (provider === 'azure') {
        config.llm_model = getValueOrNull('llm_model_azure');
        config.llm_api_key = getValueOrNull('llm_api_key_azure');
        config.llm_base_url = getValueOrNull('llm_base_url_azure');
        config.llm_api_version = getValueOrNull('llm_api_version');
    } else {
        // Generic (vllm, sglang, openrouter)
        config.llm_model = getValueOrNull('llm_model_generic');
        config.llm_api_key = getValueOrNull('llm_api_key_generic');
        config.llm_base_url = getValueOrNull('llm_base_url_generic');
    }

    // Get DB connection code (raw Python code, not JSON)
    const dbConnectionCode = formData.get('db_connection_code');
    config.db_connection_code = dbConnectionCode && dbConnectionCode.trim() ? dbConnectionCode.trim() : null;

    // Get language (disabled radio buttons don't appear in FormData, so read from DOM)
    const selectedLang = $('input[name="language"]:checked').val() || 'python';
    config.language = selectedLang;

    // Get reasoning effort
    const reasoningEffort = formData.get('reasoning_effort');
    config.reasoning_effort = (reasoningEffort && reasoningEffort !== 'not_applicable') ? reasoningEffort : null;

    // Get specialty ID and prompt
    const specialtyId = $('#specialtySelect').val();
    config.specialty_id = (specialtyId && specialtyId !== 'none') ? specialtyId : null;
    const specialtyPrompt = specialtyAce ? specialtyAce.getValue() : '';
    config.specialty_prompt = specialtyPrompt && specialtyPrompt.trim() ? specialtyPrompt.trim() : null;

    const payload = {
        name: formData.get('name'),
        config: config
    };

    try {
        let res;
        if (sessionId) {
            // Update
            res = await fetch(`/sessions/${sessionId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
        } else {
            // Create
            res = await fetch('/sessions', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
        }
        
        if(!res.ok) throw new Error(await res.text());
        
        const data = await res.json();
        
        // Hide Modal
        const modalEl = document.getElementById('sessionDialog');
        const modal = bootstrap.Modal.getInstance(modalEl);
        modal.hide();
        
        await loadSessions();
        if(!sessionId || currentSessionId === sessionId) {
            selectSession(data.session_id);
        }
        
    } catch(e) { alert(e.message); }
}

async function selectSession(id, name) {
    // Detach UI from any active stream (but do NOT abort — let the backend finish)
    if (isGenerating) {
        toggleSendButtonState(false);
    }
    $('.loading-bubble').remove();

    currentSessionId = id;
    // Resolve name: from caller, cache, or null. The cache fallback covers
    // programmatic calls like selectSession(id) from handleSaveSession().
    if (name) {
        currentSessionName = name;
    } else {
        const cached = sessionsCache.find(s => s.session_id === id);
        currentSessionName = cached ? cached.name : null;
    }
    loadSessions();

    // Reset editor when switching sessions
    closeEditor();

    const chatContainer = $('#chat-history');
    
    // Blur Loading Effect
    chatContainer.addClass('blur-loading');
    
    // Create/Show Overlay
    let overlay = $('#chat-loading-overlay');
    if(overlay.length === 0) {
        chatContainer.parent().append(`
            <div id="chat-loading-overlay" class="loading-overlay">
                <div class="spinner-border text-primary" role="status"></div>
                <div class="mt-2 text-muted small">Loading history...</div>
            </div>
        `);
        overlay = $('#chat-loading-overlay');
    }
    overlay.addClass('active');

    try {
        const res = await fetch(`/sessions/${id}/history`);
        const data = await res.json();
        
        // Clear old content only after fetch
        chatContainer.empty();
        renderHistory(data.steps);
        loadEnvironment();
        loadFiles();
    } catch(e) {
        chatContainer.empty();
        chatContainer.html(`<div class="text-danger text-center mt-5">Error: ${e.message}</div>`);
    } finally {
        chatContainer.removeClass('blur-loading');
        overlay.removeClass('active');
    }
}

async function deleteSession(e, id) {
    e.stopPropagation();
    if(!confirm("Are you sure? This deletes all files and history.")) return;

    await fetch(`/sessions/${id}`, {method: 'DELETE'});
    if(currentSessionId === id) {
        currentSessionId = null;
        $('#chat-history').html('<div class="text-center text-muted mt-5">Session deleted.</div>');
        $('#python-vars').empty();
        $('#file-tree').empty();
        closeEditor();
    }
    loadSessions();
}

// --- Chat Logic ---

function renderHistory(steps) {
    const container = $('#chat-history');
    container.empty();
    
    if(!steps || steps.length === 0) {
        container.html('<div class="text-center text-muted mt-5 small">Start by saying hello!</div>');
        return;
    }

    steps.forEach(step => {
        if(step.type === 'UserStep') {
            appendUserMessage(step.user_input);
        } else if (step.type === 'SystemStep') {
            appendSystemStep(step.system_message);
        } else if(step.type === 'AgentStep') {
            // Show agent response text if available
            if(step.response) {
                appendAgentMessage(step.response);
            }
            // Show tool call if available (skip end_round since it's a control signal)
            if(step.tool_name && step.tool_name !== 'end_round') {
                appendToolCall(step.tool_name, step.tool_args);
            }
        } else if(step.type === 'ObservationStep') {
            // Only show if there's actual output (not a placeholder)
            if(step.output) {
                appendToolOutput(step.output);
            }
        }
    });
    
    scrollToBottom(true); // Force scroll on load
}
function appendUserMessage(text) {
    $('#chat-history').append(`
        <div class="message user">
            <div class="bubble">${escapeHtml(text)}</div>
        </div>
    `);
}

function appendAgentMessage(markdown) {
    const html = marked.parse(markdown);
    const $el = $(`
        <div class="message agent">
            <div class="bubble">${html}</div>
        </div>
    `).appendTo('#chat-history');
    $el.find('pre code').each((_, block) => safeHighlight(block));
}

function appendToolCall(name, args) {
    let content = args;
    let language = 'json';
    try {
        const obj = typeof args === 'string' ? JSON.parse(args) : args;
        if (obj.code) {
            content = obj.code;
            language = 'python';
            if (name === 'RExecutor') language = 'r';
        } else {
            content = JSON.stringify(obj, null, 2);
        }
    } catch(e) {}

    const html = `
        <div class="step-box">
            <div class="step-header" onclick="$(this).next().slideToggle()">
                <span><i class="fas fa-cogs"></i> ${name}</span>
                <i class="fas fa-chevron-down small"></i>
            </div>
            <div class="step-content">
                <pre><code class="language-${language}">${escapeHtml(content)}</code></pre>
            </div>
        </div>`;
    
    const $element = $(html).appendTo('#chat-history');
    $element.find('pre code').each((i, block) => safeHighlight(block));
}

function appendToolOutput(output) {
     const html = `
        <div class="step-box">
            <div class="step-header" onclick="$(this).next().slideToggle()">
                <span><i class="fas fa-terminal"></i> Output</span>
                <i class="fas fa-chevron-down small"></i>
            </div>
            <div class="step-content">
                <pre>${escapeHtml(output)}</pre>
            </div>
        </div>`;
    $('#chat-history').append(html);
}

function appendSystemStep(system_message) {
    const html = `
        <div class="message system">
            <div class="bubble">
                <i class="fas fa-info-circle me-1"></i>
                ${escapeHtml(system_message)}
            </div>
        </div>`;
    $('#chat-history').append(html);
}

async function sendMessage() {
    if(!currentSessionId) return alert("Select a session first!");
    
    // --- STOP LOGIC ---
    if (isGenerating) {
        try {
            // 1. Abort the frontend fetch
            if (currentAbortController) currentAbortController.abort();
            
            // 2. Tell backend to stop (in case fetch abort doesn't propagate immediately)
            await fetch(`/sessions/${currentSessionId}/stop`, { method: 'POST' });
            
            // 3. UI Cleanup
            const historyRes = await fetch(`/sessions/${currentSessionId}/history`);
            if (historyRes.ok) {
                const data = await historyRes.json();
                const steps = data.steps || [];
                if (steps.length > 0) {
                    const lastStep = steps[steps.length - 1];
                    if (lastStep.type === 'SystemStep') {
                        appendSystemStep(lastStep.system_message);
                    }
                }
            }
        } catch(e) { console.error("Stop error", e); }
        finally {
            removeThinking();
            toggleSendButtonState(false);
        }
        return;
    }
    // ------------------

    const input = $('#user-input');
    const text = input.val().trim();
    if(!text) return;
    
    input.val('');
    input.css('height', 'auto'); 
    
    appendUserMessage(text);
    scrollToBottom();

    // Show Thinking Bubble
    $('#chat-history').append(`
        <div class="message agent loading-bubble">
            <div class="bubble"><i class="fas fa-circle-notch fa-spin"></i> Thinking...</div>
        </div>
    `);
    scrollToBottom();

    // Toggle to Stop Button
    toggleSendButtonState(true);
    currentAbortController = new AbortController();
    const streamSessionId = currentSessionId; // Guard: track which session this stream belongs to

    // This removes ALL elements with the class, guaranteeing cleanup.
    const removeThinking = () => {
        $('.loading-bubble').remove();
    };

    try {
        const response = await fetch(`/sessions/${streamSessionId}/chat`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Accept': 'text/event-stream'},
            body: JSON.stringify({message: text, stream: true}),
            signal: currentAbortController.signal
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = ""; 
        
        while (true) {
            const {value, done} = await reader.read();
            if (done) break;

            // Session switched — keep draining so the backend agent finishes,
            // but skip all DOM updates
            if (currentSessionId !== streamSessionId) continue;

            buffer += decoder.decode(value, {stream: true});
            const parts = buffer.split('\n\n');
            buffer = parts.pop();

            for (const part of parts) {
                if (currentSessionId !== streamSessionId) break;
                const line = part.trim();
                if (!line.startsWith('data: ')) continue;
                
                try {
                    const jsonStr = line.substring(6); 
                    const data = JSON.parse(jsonStr);

                    // 1. Full Text Response (Block)
                    if(data.type === 'response') {
                        removeThinking();
                        const html = marked.parse(data.data);
                        const newId = 'msg-' + Date.now();
                        
                        $('#chat-history').append(`
                            <div class="message agent message-block" id="${newId}">
                                <div class="bubble">${html}</div>
                            </div>
                        `);
                        
                        // Highlight code blocks
                        $(`#${newId} pre code`).each((i, block) => safeHighlight(block));
                        scrollToBottom();
                    }
                    
                    // 2. Tool Calls
                    else if(data.type === 'tool_calls') {
                        removeThinking();
                        const toolCalls = data.data; // Array of {name, arguments}
                        
                        if (Array.isArray(toolCalls)) {
                            toolCalls.forEach(tool => {
                                let args = tool.arguments;
                                if (typeof args !== 'string') args = JSON.stringify(args, null, 2);
                                appendToolCall(tool.name, args);
                            });
                        }
                        scrollToBottom();
                    }
                    
                    // 3. Tool Output
                    else if(data.type === 'tool_output') {
                        removeThinking();
                        appendToolOutput(data.data);
                        scrollToBottom();
                    }

                    // 3b. Environment update (pushed after each tool execution)
                    else if(data.type === 'env_update') {
                        renderEnvironment(data.data);
                    }

                    // 4. Done / Error
                    else if(data.type === 'done') {
                        removeThinking();
                        loadEnvironment();
                        loadFiles();
                        toggleSendButtonState(false);
                    }
                    else if(data.type === 'error') {
                         removeThinking();
                         $('#chat-history').append(`<div class="message agent"><div class="bubble text-danger">${data.data}</div></div>`);
                         toggleSendButtonState(false);
                    }

                } catch(e) {
                    console.error("Stream parse error:", e);
                }
            }
        }
    } catch(e) {
        if (e.name !== 'AbortError' && currentSessionId === streamSessionId) {
             removeThinking();
             $('#chat-history').append(`<div class="message agent"><div class="bubble text-danger">Network Error: ${e.message}</div></div>`);
        }
    } finally {
        // Only clean up UI and controller if we're still on the same session
        if (currentSessionId === streamSessionId) {
            removeThinking();
            toggleSendButtonState(false);
            currentAbortController = null;
        }
    }
}

// Helper to switch button icon/state
function toggleSendButtonState(isRunning) {
    isGenerating = isRunning;
    const btn = $('#send-btn');
    if (isRunning) {
        // Stop Icon (Square)
        btn.html('<i class="fas fa-stop"></i>');
        btn.addClass('stop'); // Use the 'stop' class defined in style.css
    } else {
        // Send Icon
        btn.html('<i class="fas fa-paper-plane"></i>');
        btn.removeClass('stop');
    }

    // Lock/unlock editor based on agent state
    setEditorReadOnly(isRunning);
}

// --- Side Panels ---
let hideModules = true;

$(document).on('change', '#var-filter-check', function() {
    hideModules = $(this).is(':checked');
    loadEnvironment(); 
});

async function loadEnvironment() {
    if(!currentSessionId) return;

    try {
        const res = await fetch(`/sessions/${currentSessionId}/variables`);
        const vars = await res.json();
        renderEnvironment(vars);
    } catch(e) {
        console.error("Env load error:", e);
    }
}

function renderEnvironment(vars) {
    const container = $('#python-vars');
    const scrollTop = container.scrollTop();

    container.empty();

    // Update Environment tab header based on language
    const lang = vars.language || 'python';
    const header = $('#env-header');
    if (lang === 'r') {
        header.html('<i class="fab fa-r-project me-1"></i>R Variables');
    } else {
        header.html('<i class="fab fa-python me-1"></i>Python Variables');
    }

    let varList = [];
    if (vars.python) {
        if (Array.isArray(vars.python)) {
            varList = vars.python;
        } else {
            varList = Object.entries(vars.python).map(([k,v]) => ({name: k, type: v, value: '', preview: String(v)}));
        }
    } else if (vars.r) {
        if (Array.isArray(vars.r)) {
            varList = vars.r;
        } else {
            varList = Object.entries(vars.r).map(([k,v]) => ({name: k, type: v, value: '', preview: String(v)}));
        }
    }

    if(varList.length === 0) {
        container.html('<div class="text-center text-muted small mt-5">No active variables</div>');
        return;
    }

    varList.sort((a,b) => a.name.localeCompare(b.name));

    varList.forEach(v => {
        const isModuleOrFunc = v.type === 'module' || v.type === 'function' || v.type === 'method';
        if (hideModules && isModuleOrFunc) return;

        const valueBadge = v.value ? `<span class="var-value">${v.value}</span>` : '';

        const item = $(`
            <div class="var-item" style="cursor: pointer;">
                <div class="var-row">
                    <span class="var-name">${v.name}</span>
                    <div class="d-flex align-items-center">
                        ${valueBadge}
                        <span class="var-type">${v.type}</span>
                    </div>
                </div>
            </div>
        `);
        item.click(() => showVariablePreview(v));
        container.append(item);
    });

    container.scrollTop(scrollTop);
}

function showVariablePreview(variable) {
    let modalEl = document.getElementById('varPreviewModal');
    if (!modalEl) {
        $('body').append(`
            <div class="modal fade" id="varPreviewModal" tabindex="-1">
                <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title" id="varPreviewTitle"></h5>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" id="varPreviewBody" style="background: var(--bg-app); color: var(--text-primary);">
                        </div>
                    </div>
                </div>
            </div>
        `);
        modalEl = document.getElementById('varPreviewModal');
    }

    $('#varPreviewTitle').text(`${variable.name} (${variable.type})`);
    
    const body = $('#varPreviewBody');
    body.empty();
    
    if (variable.preview) {
        if (variable.preview.trim().startsWith('<')) {
            body.html(variable.preview);
        } else {
            body.html(`<pre><code>${escapeHtml(variable.preview)}</code></pre>`);
            safeHighlight(body.find('pre code')[0]);
        }
    } else {
         body.html('<div class="text-muted">No preview available</div>');
    }

    const modal = new bootstrap.Modal(modalEl);
    modal.show();
}

// =============================================================================
// File Viewer & Drag-and-Drop
// =============================================================================

async function loadFiles(path = "", container = null) {
    if(!currentSessionId) return;
    
    if(!container) {
        container = $('#file-tree');
        container.empty();
    }

    try {
        const res = await fetch(`/sessions/${currentSessionId}/files?path=${encodeURIComponent(path)}`);
        const files = await res.json();
        
        if (path === "" && files.length === 0) {
            container.html('<div class="text-center text-muted small mt-5">Empty workspace</div>');
            
            // Add Global Drop Zone Listener on empty state
            bindDragEvents(container, "");
            return;
        }

        files.sort((a,b) => b.is_directory - a.is_directory); 
        
        files.forEach(f => {
            // Determine icons and actions
            const iconClass = f.is_directory ? 'fa-folder text-warning' : 'fa-file-code text-secondary';
            const caret = f.is_directory ? '<i class="fas fa-caret-right caret-icon"></i>' : '<span class="caret-spacer"></span>';
            const downloadIcon = `<i class="fas fa-download action-icon" onclick="downloadFile(event, '${f.path}')" title="Download"></i>`;
            let deleteIcon = '';
            const isProtected = (path === "" && (f.name === "uploads" || f.name === "outputs" || f.name === "scripts" || f.name === "internal"));

            if (!isProtected) {
                deleteIcon = `<i class="fas fa-trash action-icon delete-icon" onclick="deleteFile(event, '${f.path}')" title="Delete"></i>`;
            }

            const childContainerId = `folder-${Math.random().toString(36).substr(2, 9)}`;

            // Determine click action: folders toggle, files open in editor
            const fileRowClass = f.is_directory ? 'file-row' : 'file-row clickable-file';
            const clickAction = f.is_directory
                ? `toggleFolder(this, '${f.path}', '${childContainerId}')`
                : `openFileInEditor('${f.path}')`;

            const html = `
                <div class="file-node" data-path="${f.path}" data-is-dir="${f.is_directory}">
                    <div class="${fileRowClass}" onclick="${clickAction}">
                        <div class="d-flex align-items-center flex-grow-1" style="overflow:hidden;">
                            ${caret}
                            <i class="fas ${iconClass} me-2"></i>
                            <span class="text-truncate">${f.name}</span>
                        </div>
                        <div class="file-actions">
                             <span class="file-size me-2">${f.size_human}</span>
                             ${downloadIcon}
                             ${deleteIcon}
                        </div>
                    </div>
                    ${f.is_directory ? `<div class="file-children" id="${childContainerId}"></div>` : ''}
                </div>`;

            const node = $(html);
            container.append(node);

            // Bind Drag & Drop to this specific row (folder)
            if(f.is_directory) {
                 bindDragEvents(node.find('.file-row'), f.path);
            }
        });
        
        // Bind Drag & Drop to the root container if we are at root
        if(path === "") {
             bindDragEvents(container, "");
        }

    } catch(e) {
        console.error("File load error:", e);
    }
}

async function toggleFolder(element, path, containerId) {
    const childrenDiv = $(`#${containerId}`);
    const caret = $(element).find('.caret-icon');
    
    if (childrenDiv.is(':empty')) {
        // Load children
        caret.removeClass('fa-caret-right').addClass('fa-caret-down');
        await loadFiles(path, childrenDiv);
        childrenDiv.show();
    } else {
        // Toggle visibility
        if (childrenDiv.is(':visible')) {
            childrenDiv.hide();
            caret.removeClass('fa-caret-down').addClass('fa-caret-right');
        } else {
            childrenDiv.show();
            caret.removeClass('fa-caret-right').addClass('fa-caret-down');
        }
    }
}

function downloadFile(e, path) {
    e.stopPropagation();
    window.open(`/sessions/${currentSessionId}/files/${path}`, '_blank');
}

async function deleteFile(e, path) {
    e.stopPropagation();
    if(!confirm(`Are you sure you want to delete "${path}"?`)) return;

    try {
        const res = await fetch(`/sessions/${currentSessionId}/files/${path}`, {
            method: 'DELETE'
        });

        if (!res.ok) {
            const err = await res.json();
            alert("Error deleting file: " + (err.detail || "Unknown error"));
            return;
        }

        // If the deleted file is currently open in editor, close it
        if (currentFilePath && (currentFilePath === path || currentFilePath.startsWith(path + '/'))) {
            closeEditor();
        }

        // Fetch latest history step and display it (backend adds SystemStep)
        const historyRes = await fetch(`/sessions/${currentSessionId}/history`);
        if (historyRes.ok) {
            const data = await historyRes.json();
            const steps = data.steps || [];
            if (steps.length > 0) {
                const lastStep = steps[steps.length - 1];
                if (lastStep.type === 'SystemStep') {
                    appendSystemStep(lastStep.system_message);
                    scrollToBottom();
                }
            }
        }

        // Refresh the file tree
        loadFiles();
    } catch(e) {
        alert("Network error: " + e.message);
    }
}

// --- Drag and Drop Logic ---

function bindDragEvents(element, targetPath) {
    const el = element[0]; // Get raw DOM element
    
    // Prevent default behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        el.addEventListener(eventName, preventDefaults, false);
    });

    // Highlight
    ['dragenter', 'dragover'].forEach(eventName => {
        el.addEventListener(eventName, () => element.addClass('drag-highlight'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        el.addEventListener(eventName, () => element.removeClass('drag-highlight'), false);
    });

    // Handle Drop
    el.addEventListener('drop', (e) => handleDrop(e, targetPath), false);
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

async function handleDrop(e, targetPath) {
    const items = e.dataTransfer.items;
    if (!items) return;

    let uploadPromises = [];

    // Use webkitGetAsEntry for folder support
    for (let i = 0; i < items.length; i++) {
        const item = items[i].webkitGetAsEntry();
        if (item) {
            uploadPromises.push(traverseFileTree(item, targetPath));
        }
    }

    await Promise.all(uploadPromises);
    
    // Refresh view
    if (targetPath === "") loadFiles();
    else {
        // If we dropped into a subfolder, we ideally refresh just that folder
        // For simplicity, we can reload the whole root or try to find the specific DOM node
        // Let's reload root for consistency
        loadFiles();
    }
}

function traverseFileTree(item, path) {
    return new Promise((resolve) => {
        if (item.isFile) {
            item.file(function(file) {
                uploadFile(file, path).then(resolve);
            });
        } else if (item.isDirectory) {
            const dirReader = item.createReader();
            const dirPath = path ? path + "/" + item.name : item.name;
            
            // Read entries
            const readEntries = () => {
                dirReader.readEntries(async function(entries) {
                    if (entries.length > 0) {
                        const promises = entries.map(entry => traverseFileTree(entry, dirPath));
                        await Promise.all(promises);
                        readEntries(); // Continue reading (readEntries returns blocks)
                    } else {
                        resolve();
                    }
                });
            };
            readEntries();
        }
    });
}

async function uploadFile(file, path) {
    const formData = new FormData();
    formData.append('file', file);
    
    // path query param is the directory to upload INTO
    const uploadUrl = `/sessions/${currentSessionId}/files?path=${encodeURIComponent(path)}`;
    
    try {
        const res = await fetch(uploadUrl, {method: 'POST', body: formData});
        if (res.ok) {
            // Fetch latest history step and display it (backend adds SystemStep)
            const historyRes = await fetch(`/sessions/${currentSessionId}/history`);
            if (historyRes.ok) {
                const data = await historyRes.json();
                const steps = data.steps || [];
                if (steps.length > 0) {
                    const lastStep = steps[steps.length - 1];
                    if (lastStep.type === 'SystemStep') {
                        appendSystemStep(lastStep.system_message);
                        scrollToBottom();
                    }
                }
            }
        }
    } catch(e) {
        console.error("Upload failed for " + file.name, e);
    }
}

async function uploadFilesFromInput(fileList, path) {
    for (let i = 0; i < fileList.length; i++) {
        await uploadFile(fileList[i], path);
    }
    loadFiles();
}

function scrollToBottom(force = false) {
    if (force || isUserAtBottom) {
        const d = $('#chat-history');
        if (d.length) d.scrollTop(d[0].scrollHeight);
    }
}

function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// =============================================================================
// File Editor
// =============================================================================

function initEditorBindings() {
    // Save button click
    $(document).on('click', '#editor-save-btn', saveCurrentFile);

    // Download button click
    $(document).on('click', '#editor-download-btn', () => {
        if (currentFilePath && currentSessionId) {
            window.open(`/sessions/${currentSessionId}/files/${currentFilePath}`, '_blank');
        }
    });

    // Run entire script
    $(document).on('click', '#editor-run-btn', () => runEditorScript());

    // Run current line / selection
    $(document).on('click', '#editor-run-line-btn', () => runEditorLine());

    // Keyboard shortcut: Ctrl+S to save
    $(document).on('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            // Only if editor is active and has content
            if (currentFilePath && isEditorDirty && !isGenerating) {
                e.preventDefault();
                saveCurrentFile();
            }
        }
    });
}

function getAceMode(ext) {
    // Map file extensions to Ace Editor modes
    const modeMap = {
        '.py': 'python',
        '.python': 'python',
        '.r': 'r',
        '.R': 'r',
        '.sql': 'sql',
        '.json': 'json',
        '.md': 'markdown',
        '.markdown': 'markdown',
        '.js': 'javascript',
        '.ts': 'typescript',
        '.jsx': 'javascript',
        '.tsx': 'typescript',
        '.html': 'html',
        '.css': 'css',
        '.xml': 'xml',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.sh': 'sh',
        '.bash': 'sh',
        '.csv': 'text',
        '.tsv': 'text',
        '.txt': 'text',
        '.log': 'text',
        '.ini': 'ini',
        '.cfg': 'ini',
        '.conf': 'ini',
        '.toml': 'toml'
    };
    return modeMap[ext] || 'text';
}

async function openFileInEditor(filePath) {
    if (!currentSessionId) {
        alert('Please select a session first');
        return;
    }

    // Check for unsaved changes
    if (isEditorDirty && currentFilePath) {
        if (!confirm(`You have unsaved changes in "${currentFilePath}". Discard and open new file?`)) {
            return;
        }
    }

    const content = $('#editor-content');
    const statusBar = $('#editor-status');
    const filePathDisplay = $('#editor-file-path');
    const saveBtn = $('#editor-save-btn');
    const warning = $('#editor-warning');

    // Snapshot current editor DOM so we can restore it if the file turns out
    // to be non-editable (we don't know until after the fetch).
    const savedEditorHtml = content.html();
    const savedFilePathText = filePathDisplay.text();
    const savedFilePath = currentFilePath;

    // Show loading state
    content.html('<div class="editor-placeholder"><i class="fas fa-spinner fa-spin fa-2x"></i><div class="mt-2">Loading...</div></div>');
    warning.hide();

    try {
        // Encode path segments individually to preserve slashes
        const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        const res = await fetch(`/sessions/${currentSessionId}/files/${encodedPath}/content`);
        if (!res.ok) {
            throw new Error(await res.text());
        }

        const data = await res.json();

        // Update file tree highlighting regardless of file type
        $('.file-row').removeClass('file-active');
        $(`.file-node[data-path="${filePath}"] > .file-row`).addClass('file-active');

        // Handle different file types
        const isCSV = data.file_type === 'text' && (data.extension === '.csv' || data.extension === '.tsv');
        const isNonEditable = data.file_type === 'image' || data.file_type === 'binary' || isCSV;

        if (isNonEditable) {
            // Restore editor to its previous state — non-editable files open in
            // the FileViewer tab and should not affect the editor at all.
            content.html(savedEditorHtml);
            filePathDisplay.text(savedFilePathText);
            currentFilePath = savedFilePath;
            warning.hide();
            openFileInViewer(filePath, data);
            return;
        }

        // Editable text file — commit the navigation
        currentFilePath = filePath;
        filePathDisplay.text(filePath);

        if (data.is_truncated) {
            warning.show();
            $('#editor-warning-text').text(`Large file: showing first 1000 of ${data.total_lines} lines. Download to view full file.`);
        }

        originalContent = data.content;
        isEditorDirty = false;
        createAceEditorForFile(content, data);

        // Update run buttons based on file type
        updateRunButtons(data.extension);

        // Apply read-only state if agent is running
        setEditorReadOnly(isGenerating);

        // Switch to Editor tab
        switchToEditorTab();

    } catch (e) {
        console.error('Failed to open file:', e);
        content.html(`
            <div class="editor-placeholder text-danger">
                <i class="fas fa-exclamation-circle fa-2x mb-2"></i>
                <div>Failed to load file</div>
                <div class="small mt-2">${escapeHtml(e.message)}</div>
            </div>
        `);
        currentFilePath = null;
        originalContent = null;
        isEditorDirty = false;
    }
}

function renderCSVTable(content, delimiter = ',') {
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length === 0) {
        return '<div class="text-muted text-center p-3">Empty file</div>';
    }

    // Simple CSV parsing (handles basic cases)
    const parseCSVLine = (line) => {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === delimiter && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result;
    };

    const rows = lines.map(line => parseCSVLine(line));
    const headers = rows[0] || [];
    const dataRows = rows.slice(1);

    let html = '<table class="df-table csv-table"><thead><tr>';
    html += '<th class="row-num">#</th>';
    headers.forEach(h => {
        html += `<th>${escapeHtml(h)}</th>`;
    });
    html += '</tr></thead><tbody>';

    dataRows.forEach((row, idx) => {
        html += `<tr><td class="row-num">${idx + 1}</td>`;
        row.forEach(cell => {
            html += `<td>${escapeHtml(cell)}</td>`;
        });
        // Fill empty cells if row is shorter than header
        for (let i = row.length; i < headers.length; i++) {
            html += '<td></td>';
        }
        html += '</tr>';
    });

    html += '</tbody></table>';
    return html;
}

function createAceEditorForFile(container, data) {
    // Destroy existing editor
    if (aceEditor) {
        aceEditor.destroy();
        aceEditor = null;
    }

    // Create Ace Editor container
    container.html('<div id="ace-editor-container"></div>');

    aceEditor = ace.edit('ace-editor-container');
    aceEditor.setValue(data.content, -1); // -1 moves cursor to start

    // Configure Ace Editor
    const aceMode = getAceMode(data.extension);
    aceEditor.session.setMode(`ace/mode/${aceMode}`);
    aceEditor.setTheme(isDarkMode ? 'ace/theme/monokai' : 'ace/theme/chrome');
    aceEditor.setOptions({
        fontSize: '14px',
        showPrintMargin: false,
        wrap: false,
        tabSize: 4,
        useSoftTabs: true
    });

    // Change detection
    aceEditor.session.on('change', () => {
        isEditorDirty = aceEditor.getValue() !== originalContent;
        updateEditorStatus();
    });

    // Shift+Enter: run line / selection
    aceEditor.commands.addCommand({
        name: 'runLine',
        bindKey: { win: 'Shift-Enter', mac: 'Shift-Enter' },
        exec: () => runEditorLine(),
        readOnly: true
    });

    $('#editor-save-btn').prop('disabled', true); // No changes yet
    $('#editor-status').text('Ready').removeClass('modified saved');
}

function updateEditorStatus() {
    const statusBar = $('#editor-status');
    const saveBtn = $('#editor-save-btn');

    if (isEditorDirty) {
        statusBar.text('Modified').addClass('modified').removeClass('saved');
        saveBtn.prop('disabled', isGenerating); // Disable if agent is running
    } else {
        statusBar.text('Ready').removeClass('modified saved');
        saveBtn.prop('disabled', true);
    }
}

async function saveCurrentFile() {
    if (!currentSessionId || !currentFilePath || isGenerating) {
        return;
    }

    if (!aceEditor) {
        return;
    }

    const content = aceEditor.getValue();

    const saveBtn = $('#editor-save-btn');
    const statusBar = $('#editor-status');

    // Show saving state
    saveBtn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> Saving...');

    try {
        // Encode path segments individually to preserve slashes
        const encodedPath = currentFilePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        const res = await fetch(`/sessions/${currentSessionId}/files/${encodedPath}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });

        if (!res.ok) {
            throw new Error(await res.text());
        }

        // Update state
        originalContent = content;
        isEditorDirty = false;

        // Show success
        statusBar.text('Saved!').removeClass('modified').addClass('saved');
        saveBtn.html('<i class="fas fa-save"></i> Save');

        // Fetch and display the system message
        const historyRes = await fetch(`/sessions/${currentSessionId}/history`);
        if (historyRes.ok) {
            const data = await historyRes.json();
            const steps = data.steps || [];
            if (steps.length > 0) {
                const lastStep = steps[steps.length - 1];
                if (lastStep.type === 'SystemStep') {
                    appendSystemStep(lastStep.system_message);
                    scrollToBottom();
                }
            }
        }

        // Reset status after a moment
        setTimeout(() => {
            if (!isEditorDirty) {
                statusBar.text('Ready').removeClass('saved');
            }
        }, 2000);

    } catch (e) {
        console.error('Failed to save file:', e);
        alert('Failed to save file: ' + e.message);
        saveBtn.html('<i class="fas fa-save"></i> Save');
        updateEditorStatus(); // Re-enable if dirty
    }
}

function setEditorReadOnly(readOnly) {
    const overlay = $('#editor-readonly-overlay');

    if (readOnly) {
        overlay.show();
        if (aceEditor) {
            aceEditor.setReadOnly(true);
        }
    } else {
        overlay.hide();
        if (aceEditor) {
            aceEditor.setReadOnly(false);
        }
    }

    updateEditorStatus();
}

function switchToEditorTab() {
    // Find and activate the Editor tab in Golden Layout
    if (layout && layout.root) {
        const findAndActivate = (item) => {
            if (item.componentName === 'Editor' && item.parent && item.parent.setActiveContentItem) {
                item.parent.setActiveContentItem(item);
                return true;
            }
            if (item.contentItems) {
                for (const child of item.contentItems) {
                    if (findAndActivate(child)) return true;
                }
            }
            return false;
        };
        findAndActivate(layout.root);
    }
}

function closeEditor() {
    if (aceEditor) {
        aceEditor.destroy();
        aceEditor = null;
    }
    currentFilePath = null;
    originalContent = null;
    isEditorDirty = false;

    $('#editor-content').html(`
        <div class="editor-placeholder">
            <i class="fas fa-file-code fa-3x mb-3"></i>
            <div>Click a file in the workspace to open it here</div>
            <div class="small text-muted mt-2">Supported: .py, .r, .sql, .csv, .json, .md, and more</div>
        </div>
    `);
    $('#editor-file-path').text('');
    $('#editor-status').text('').removeClass('modified saved');
    $('#editor-save-btn').prop('disabled', true);
    $('#editor-run-btn').prop('disabled', true);
    $('#editor-run-line-btn').prop('disabled', true);
    $('#editor-warning').hide();

    // Remove file highlighting
    $('.file-row').removeClass('file-active');
}

// =============================================================================
// File Viewer (non-editable files: images, CSV, binary)
// =============================================================================

function openFileInViewer(filePath, data) {
    const content = $('#fileviewer-content');
    const pathEl = $('#fileviewer-file-path');
    const downloadBtn = $('#fileviewer-download-btn');

    if (!content.length) {
        // FileViewer panel not yet mounted — switch tab first then retry
        switchToFileViewerTab();
        setTimeout(() => openFileInViewer(filePath, data), 150);
        return;
    }

    pathEl.text(filePath);
    downloadBtn.show().off('click').on('click', () => {
        if (currentSessionId) {
            window.open(`/sessions/${currentSessionId}/files/${filePath}`, '_blank');
        }
    });

    if (data.file_type === 'image') {
        content.html(`
            <div class="editor-image-preview">
                <img src="${data.content}" alt="${escapeHtml(filePath)}">
            </div>
        `);
    } else if (data.file_type === 'binary') {
        content.html(`
            <div class="editor-binary-message">
                <i class="fas fa-file fa-3x mb-3"></i>
                <div>Binary file — cannot preview</div>
                <div class="small text-muted mt-2">Use the download button to view this file locally</div>
            </div>
        `);
    } else {
        // CSV / TSV table view
        const delimiter = data.extension === '.tsv' ? '\t' : ',';
        const tableHtml = renderCSVTable(data.content, delimiter);
        content.html(`
            <div class="csv-view-container">
                <div class="csv-table-wrapper">${tableHtml}</div>
            </div>
        `);
    }

    switchToFileViewerTab();
}

function switchToFileViewerTab() {
    if (layout && layout.root) {
        const find = (item) => {
            if (item.componentName === 'FileViewer' && item.parent && item.parent.setActiveContentItem) {
                item.parent.setActiveContentItem(item);
                return true;
            }
            if (item.contentItems) {
                for (const child of item.contentItems) { if (find(child)) return true; }
            }
            return false;
        };
        find(layout.root);
    }
}

// =============================================================================
// Editor Run Helpers
// =============================================================================

const RUNNABLE_EXTENSIONS = new Set(['.py', '.r', '.R', '.sh', '.bash']);

function updateRunButtons(ext) {
    const runnable = RUNNABLE_EXTENSIONS.has(ext);
    $('#editor-run-btn').prop('disabled', !runnable);
    $('#editor-run-line-btn').prop('disabled', !runnable);
}

function runEditorScript() {
    if (!aceEditor) return;
    const code = aceEditor.getValue();
    if (!code.trim()) return;
    sendCodeToTerminal(code);
}

function runEditorLine() {
    if (!aceEditor) return;
    const selection = aceEditor.getSelectedText();
    let code;
    let advanceLine = false;
    if (selection && selection.trim()) {
        code = selection;
    } else {
        // No selection — use the current line and advance afterwards
        const row = aceEditor.getCursorPosition().row;
        code = aceEditor.session.getLine(row);
        advanceLine = true;
    }
    if (!code.trim()) return;
    // keepEditorFocus=true so cursor stays in editor for continuous line stepping
    sendCodeToTerminal(code + '\n', true);
    // Move to the next line so repeated Shift+Enter steps through the file
    if (advanceLine) {
        const row = aceEditor.getCursorPosition().row;
        const lastRow = aceEditor.session.getLength() - 1;
        aceEditor.moveCursorTo(Math.min(row + 1, lastRow), 0);
    }
}

function sendCodeToTerminal(code, keepEditorFocus = false) {
    // Detect language from the open file's extension
    const ext = currentFilePath ? currentFilePath.split('.').pop().toLowerCase() : '';

    // Switch the Terminal GL tab into view so the user sees output, but do NOT
    // call xterm.focus() when keepEditorFocus is true (e.g. Run Line).
    switchToTerminalGLTab();

    const isNewTerminal = !activeTerminalId || !terminals[activeTerminalId];
    if (isNewTerminal) {
        openNewTerminal(() => {
            // Auto-start the correct interpreter when a fresh terminal is created,
            // then send the code once the interpreter is ready.
            _autoStartInterpreterThenSend(ext, code, keepEditorFocus);
        });
        return;
    }
    _doSendCode(code, keepEditorFocus);
}

// Send the interpreter start command, wait for it to initialise, then send code.
function _autoStartInterpreterThenSend(ext, code, keepEditorFocus) {
    const t = terminals[activeTerminalId];
    if (!t || !t.ws || t.ws.readyState !== WebSocket.OPEN) return;

    if (ext === 'py') {
        t.ws.send(new TextEncoder().encode('python3\n'));
        setTimeout(() => _doSendCode(code, keepEditorFocus), 800);
    } else if (ext === 'r') {
        t.ws.send(new TextEncoder().encode('R --quiet\n'));
        setTimeout(() => _doSendCode(code, keepEditorFocus), 1500);
    } else {
        _doSendCode(code, keepEditorFocus);
    }
}

function _doSendCode(code, keepEditorFocus = false) {
    const t = terminals[activeTerminalId];
    if (!t || !t.ws || t.ws.readyState !== WebSocket.OPEN) return;

    if (!code.endsWith('\n')) code += '\n';
    t.ws.send(new TextEncoder().encode(code));

    // Focus xterm only when running the full script (Run button).
    // For Run Line (Shift+Enter) the editor keeps focus so the user can
    // continue stepping through lines without clicking back.
    if (!keepEditorFocus) {
        t.xterm.focus();
    }
}

// =============================================================================
// Terminal Panel
// =============================================================================

function initTerminalPanel(container) {
    terminalComponentReady = true;

    // Restore terminals saved before a page refresh
    restoreTerminalsFromSession();

    $(document).on('click', '#terminal-new-btn', () => openNewTerminal());

    // Tab list scroll arrows
    $(document).on('click', '#terminal-scroll-left', () => {
        const list = document.getElementById('terminal-tabs-list');
        if (list) list.scrollBy({ left: -120, behavior: 'smooth' });
    });
    $(document).on('click', '#terminal-scroll-right', () => {
        const list = document.getElementById('terminal-tabs-list');
        if (list) list.scrollBy({ left: 120, behavior: 'smooth' });
    });

    // Resize xterm when GL panel is resized
    container.on('resize', () => {
        if (activeTerminalId && terminals[activeTerminalId]) {
            terminals[activeTerminalId].fitAddon.fit();
        }
        updateTabScrollArrows();
    });
}

// Show/hide scroll arrows based on whether the tab list overflows
function updateTabScrollArrows() {
    const list = document.getElementById('terminal-tabs-list');
    if (!list) return;
    const overflows = list.scrollWidth > list.clientWidth;
    $('#terminal-scroll-left').toggle(overflows);
    $('#terminal-scroll-right').toggle(overflows);
}


function generateUUID() {
    // crypto.randomUUID() requires a secure context (HTTPS/localhost).
    // crypto.getRandomValues() works over plain HTTP too.
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

function openNewTerminal(onReady) {
    if (!terminalComponentReady) {
        switchToTerminalGLTab();
        setTimeout(() => openNewTerminal(onReady), 200);
        return;
    }

    const terminalId = generateUUID();
    // Use the session name if available; suffix with a counter when there are
    // multiple terminals open for the same session.
    const sessionTerminals = Object.values(terminals).filter(t => t.sessionId === currentSessionId).length;
    const baseName = currentSessionName || 'Terminal';
    const title = sessionTerminals === 0 ? baseName : `${baseName} (${sessionTerminals + 1})`;

    // Create container div inside #terminal-body
    const body = document.getElementById('terminal-body');
    if (!body) return;

    const placeholder = document.getElementById('terminal-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    const containerEl = document.createElement('div');
    containerEl.id = `terminal-instance-${terminalId}`;
    containerEl.className = 'terminal-instance';
    body.appendChild(containerEl);

    // Create xterm instance
    const xterm = new Terminal({
        theme: {
            background: '#1e1e1e',
            foreground: '#cccccc',
            cursor: '#cccccc',
            selectionBackground: 'rgba(255,255,255,0.25)',
        },
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerEl);
    setTimeout(() => fitAddon.fit(), 50);


    // Create WebSocket connection
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProto}://${location.host}/ws/terminal/${terminalId}?session_id=${currentSessionId || ''}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        // Send initial terminal size
        ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
        if (onReady) onReady();
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            xterm.write(new Uint8Array(event.data));
        } else if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'exit') {
                    xterm.write('\r\n\x1b[2m[Process exited]\x1b[0m\r\n');
                }
            } catch (_) {
                xterm.write(event.data);
            }
        }
    };

    ws.onclose = () => {
        xterm.write('\r\n\x1b[2m[Disconnected]\x1b[0m\r\n');
    };

    // Forward keyboard input to PTY
    xterm.onData(data => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(data));
        }
    });

    // Notify backend of resize
    xterm.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
    });

    // Create the sub-tab
    const tabEl = createTerminalTabElement(terminalId, title);

    terminals[terminalId] = { xterm, fitAddon, ws, containerEl, tabEl, title, sessionId: currentSessionId };
    activateTerminal(terminalId);

    return terminalId;
}

function createTerminalTabElement(terminalId, title) {
    const tabEl = document.createElement('div');
    tabEl.className = 'terminal-tab';
    tabEl.dataset.terminalId = terminalId;
    tabEl.innerHTML = `
        <span class="terminal-tab-title">${escapeHtml(title)}</span>
        <span class="terminal-tab-close" title="Close terminal"><i class="fas fa-times"></i></span>
    `;

    tabEl.addEventListener('click', (e) => {
        if (e.target.closest('.terminal-tab-close')) {
            closeTerminal(terminalId);
        } else {
            activateTerminal(terminalId);
        }
    });

    const list = document.getElementById('terminal-tabs-list');
    if (list) list.appendChild(tabEl);
    updateTabScrollArrows();

    return tabEl;
}

function activateTerminal(terminalId) {
    // Deactivate all
    Object.entries(terminals).forEach(([id, t]) => {
        t.containerEl.classList.remove('active');
        t.tabEl.classList.remove('active');
    });

    // Activate the selected one
    const t = terminals[terminalId];
    if (!t) return;

    t.containerEl.classList.add('active');
    t.tabEl.classList.add('active');
    activeTerminalId = terminalId;

    setTimeout(() => {
        t.fitAddon.fit();
        t.xterm.focus();
    }, 30);
}

function closeTerminal(terminalId) {
    const t = terminals[terminalId];
    if (!t) return;

    // Tell server to destroy it immediately
    fetch(`/terminal/${terminalId}`, { method: 'DELETE' }).catch(() => {});

    t.ws.close();
    t.xterm.dispose();
    t.containerEl.remove();
    t.tabEl.remove();
    delete terminals[terminalId];
    updateTabScrollArrows();

    if (activeTerminalId === terminalId) {
        activeTerminalId = null;
        const remaining = Object.keys(terminals);
        if (remaining.length > 0) {
            activateTerminal(remaining[remaining.length - 1]);
        } else {
            // Show placeholder again
            const placeholder = document.getElementById('terminal-placeholder');
            if (placeholder) placeholder.style.display = '';
        }
    }
}

function switchToTerminalGLTab() {
    if (layout && layout.root) {
        const find = (item) => {
            if (item.componentName === 'Terminal' && item.parent && item.parent.setActiveContentItem) {
                item.parent.setActiveContentItem(item);
                return true;
            }
            if (item.contentItems) {
                for (const child of item.contentItems) { if (find(child)) return true; }
            }
            return false;
        };
        find(layout.root);
    }
}

// Persist terminal IDs across page refresh so the server can reconnect them
window.addEventListener('beforeunload', () => {
    const saved = Object.entries(terminals).map(([id, t]) => ({
        id, title: t.title, sessionId: t.sessionId
    }));
    if (saved.length > 0) {
        sessionStorage.setItem('analyst_terminals', JSON.stringify(saved));
    }
});

function restoreTerminalsFromSession() {
    const stored = sessionStorage.getItem('analyst_terminals');
    if (!stored) return;
    sessionStorage.removeItem('analyst_terminals');

    let saved;
    try { saved = JSON.parse(stored); } catch (_) { return; }

    saved.forEach(({ id, title, sessionId }) => {
        reconnectTerminal(id, title, sessionId);
    });
}

function reconnectTerminal(terminalId, title, sessionId) {
    const body = document.getElementById('terminal-body');
    if (!body) return;

    const placeholder = document.getElementById('terminal-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    const containerEl = document.createElement('div');
    containerEl.id = `terminal-instance-${terminalId}`;
    containerEl.className = 'terminal-instance';
    body.appendChild(containerEl);

    const xterm = new Terminal({
        theme: { background: '#1e1e1e', foreground: '#cccccc', cursor: '#cccccc' },
        fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerEl);
    setTimeout(() => fitAddon.fit(), 50);

    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${wsProto}://${location.host}/ws/terminal/${terminalId}?session_id=${sessionId || ''}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
    };
    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            xterm.write(new Uint8Array(event.data));
        } else if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'exit') xterm.write('\r\n\x1b[2m[Process exited]\x1b[0m\r\n');
            } catch (_) { xterm.write(event.data); }
        }
    };
    ws.onclose = () => xterm.write('\r\n\x1b[2m[Disconnected]\x1b[0m\r\n');
    xterm.onData(data => {
        if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
    });
    xterm.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    const tabEl = createTerminalTabElement(terminalId, title);
    terminals[terminalId] = { xterm, fitAddon, ws, containerEl, tabEl, title, sessionId };
    activateTerminal(terminalId);
}