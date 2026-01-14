-- Neuralwatt Energy Monitor for Neovim
-- Shows live energy usage from Neuralwatt API

local M = {}

-- State
local state = {
  session_start_kwh = nil,  -- Energy at session start
  session_start_requests = nil,
  current = nil,            -- Latest API response
  today = nil,              -- Today's stats from daily array
  last_fetch = 0,
  timer = nil,
  win = nil,
  buf = nil,
}

-- Config
M.config = {
  api_key_file = vim.fn.expand("~/.config/neuralwatt/neuralwatt_portal_key"),
  poll_interval_ms = 30000,  -- 30 seconds
  auto_start = true,
}

-- Read API key from file
local function get_api_key()
  local f = io.open(M.config.api_key_file, "r")
  if not f then return nil end
  local key = f:read("*a"):gsub("%s+", "")
  f:close()
  return key
end

-- Fetch energy data from API
function M.fetch(callback)
  local api_key = get_api_key()
  if not api_key then
    vim.notify("Neuralwatt: API key not found", vim.log.levels.ERROR)
    return
  end

  local cmd = string.format(
    'curl -s "https://api.neuralwatt.com/v1/usage/energy" -H "Authorization: Bearer %s" -H "User-Agent: nvim-neuralwatt/1.0"',
    api_key
  )

  vim.fn.jobstart(cmd, {
    stdout_buffered = true,
    on_stdout = function(_, data)
      if data and data[1] and data[1] ~= "" then
        local ok, json = pcall(vim.json.decode, table.concat(data, ""))
        if ok and json then
          state.current = json
          state.last_fetch = os.time()

          -- Extract today's stats
          local today_str = os.date("%Y-%m-%d")
          if json.daily then
            for _, day in ipairs(json.daily) do
              if day.date == today_str then
                state.today = day
                break
              end
            end
          end

          -- Initialize session baseline on first fetch
          if state.session_start_kwh == nil and json.totals then
            state.session_start_kwh = json.totals.energy_kwh
            state.session_start_requests = json.totals.requests
          end

          if callback then callback(json) end
        end
      end
    end,
  })
end

-- Format energy for display (auto-scale to keep value between 1-999)
local function format_kwh(kwh)
  local wh = kwh * 1000  -- Convert kWh to Wh

  if wh >= 1000 then
    return string.format("%.2f kWh", wh / 1000)
  elseif wh >= 1 then
    return string.format("%.2f Wh", wh)
  elseif wh >= 0.001 then
    return string.format("%.2f mWh", wh * 1000)
  elseif wh >= 0.000001 then
    return string.format("%.2f uWh", wh * 1000000)
  else
    return "0 Wh"
  end
end

-- Get current stats as table
function M.get_stats()
  if not state.current then
    return nil
  end

  local totals = state.current.totals
  local session_kwh = totals.energy_kwh - (state.session_start_kwh or totals.energy_kwh)
  local session_requests = totals.requests - (state.session_start_requests or totals.requests)

  return {
    -- Session (since nvim started)
    session_kwh = session_kwh,
    session_requests = session_requests,
    -- Today
    today_kwh = state.today and state.today.energy_kwh or 0,
    today_requests = state.today and state.today.requests or 0,
    today_joules = state.today and state.today.energy_joules or 0,
    -- 30-day totals
    total_kwh = totals.energy_kwh,
    total_requests = totals.requests,
    total_joules = totals.energy_joules,
    -- Meta
    last_fetch = state.last_fetch,
  }
end

-- Create floating window with stats
function M.show_float()
  M.fetch(function()
    local stats = M.get_stats()
    if not stats then
      vim.notify("Neuralwatt: No data available", vim.log.levels.WARN)
      return
    end

    local lines = {
      " Neuralwatt Energy ",
      string.rep("─", 28),
      "",
      " Session:",
      string.format("   %s  (%d reqs)", format_kwh(stats.session_kwh), stats.session_requests),
      "",
      " Today:",
      string.format("   %s  (%d reqs)", format_kwh(stats.today_kwh), stats.today_requests),
      "",
      " 30-Day Total:",
      string.format("   %s  (%d reqs)", format_kwh(stats.total_kwh), stats.total_requests),
      "",
    }

    -- Close existing window if any
    if state.win and vim.api.nvim_win_is_valid(state.win) then
      vim.api.nvim_win_close(state.win, true)
    end

    -- Create buffer
    state.buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(state.buf, 0, -1, false, lines)
    vim.api.nvim_buf_set_option(state.buf, 'modifiable', false)
    vim.api.nvim_buf_set_option(state.buf, 'bufhidden', 'wipe')

    -- Calculate window size and position
    local width = 30
    local height = #lines
    local row = 1
    local col = vim.o.columns - width - 2

    -- Create floating window
    state.win = vim.api.nvim_open_win(state.buf, false, {
      relative = 'editor',
      width = width,
      height = height,
      row = row,
      col = col,
      style = 'minimal',
      border = 'rounded',
      title = ' Energy ',
      title_pos = 'center',
    })

    -- Set window options
    vim.api.nvim_win_set_option(state.win, 'winblend', 10)

    -- Close on any key press or cursor move
    vim.api.nvim_buf_set_keymap(state.buf, 'n', 'q', ':close<CR>', { noremap = true, silent = true })

    -- Auto-close after 5 seconds
    vim.defer_fn(function()
      if state.win and vim.api.nvim_win_is_valid(state.win) then
        vim.api.nvim_win_close(state.win, true)
        state.win = nil
      end
    end, 5000)
  end)
end

-- Toggle persistent mini-window in corner
function M.toggle_mini()
  if state.win and vim.api.nvim_win_is_valid(state.win) then
    vim.api.nvim_win_close(state.win, true)
    state.win = nil
    return
  end

  local function update_mini()
    local stats = M.get_stats()
    if not stats then return end

    local lines = {
      string.format(" S: %s ", format_kwh(stats.session_kwh)),
      string.format(" T: %s ", format_kwh(stats.today_kwh)),
    }

    if not state.buf or not vim.api.nvim_buf_is_valid(state.buf) then
      state.buf = vim.api.nvim_create_buf(false, true)
    end

    vim.api.nvim_buf_set_option(state.buf, 'modifiable', true)
    vim.api.nvim_buf_set_lines(state.buf, 0, -1, false, lines)
    vim.api.nvim_buf_set_option(state.buf, 'modifiable', false)

    if not state.win or not vim.api.nvim_win_is_valid(state.win) then
      local width = 18
      local height = 2
      state.win = vim.api.nvim_open_win(state.buf, false, {
        relative = 'editor',
        width = width,
        height = height,
        row = 1,
        col = vim.o.columns - width - 2,
        style = 'minimal',
        border = 'rounded',
        focusable = false,
      })
      vim.api.nvim_win_set_option(state.win, 'winblend', 20)
    end
  end

  -- Initial fetch and display
  M.fetch(update_mini)
end

-- Start background polling
function M.start_polling()
  if state.timer then return end

  -- Initial fetch
  M.fetch()

  -- Set up timer
  state.timer = vim.loop.new_timer()
  state.timer:start(M.config.poll_interval_ms, M.config.poll_interval_ms, vim.schedule_wrap(function()
    M.fetch()
  end))
end

-- Stop polling
function M.stop_polling()
  if state.timer then
    state.timer:stop()
    state.timer:close()
    state.timer = nil
  end
end

-- Notify current stats
function M.notify()
  M.fetch(function()
    local stats = M.get_stats()
    if not stats then return end

    local msg = string.format(
      "Session: %s (%d reqs)\nToday: %s (%d reqs)",
      format_kwh(stats.session_kwh), stats.session_requests,
      format_kwh(stats.today_kwh), stats.today_requests
    )
    vim.notify(msg, vim.log.levels.INFO, { title = "Neuralwatt Energy" })
  end)
end

-- Setup function
function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})

  -- Create commands
  vim.api.nvim_create_user_command('NeuralwattEnergy', function() M.show_float() end, {})
  vim.api.nvim_create_user_command('NeuralwattMini', function() M.toggle_mini() end, {})
  vim.api.nvim_create_user_command('NeuralwattNotify', function() M.notify() end, {})

  if M.config.auto_start then
    M.start_polling()
  end
end

return M
