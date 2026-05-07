class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.4.0/ryusei-mogi-agentmux-0.4.0.tgz"
  sha256 "a0a792071128e81ee5be9f165f8dc41782e387223afab76c4a045291302993a2"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args(prefix: libexec, ignore_scripts: false)
    bin.install_symlink libexec/"bin/agentmux"
  end

  test do
    assert_match "0.4.0", shell_output("#{bin}/agentmux --version")
  end
end
