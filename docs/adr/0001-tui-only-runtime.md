# Limit pi-history runtime behavior to TUI sessions

pi-history runs only in TUI sessions; RPC, JSON, and print modes may expose static extension metadata but perform no pi-history runtime behavior. This deliberately removes prior RPC prompt capture because pi-history exists to augment the interactive editor, and automation must not gain implicit history side effects.
