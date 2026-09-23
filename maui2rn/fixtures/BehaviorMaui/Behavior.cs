using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;

namespace BehaviorMaui;

[AttributeUsage(AttributeTargets.Field)] sealed class ObservablePropertyAttribute : Attribute { }
[AttributeUsage(AttributeTargets.Method)] sealed class RelayCommandAttribute : Attribute { }
sealed class Shell {
  public static Shell Current { get; } = new();
  public Task GoToAsync(string route) => Task.CompletedTask;
}
public sealed class Customer { public int Id { get; set; } public string Name { get; set; } = ""; }
public sealed class MainPageViewModel {
  [ObservableProperty, Required] private string query = "";
  public List<Customer> Customers { get; set; } = new();
  [RelayCommand] public void Open() { _ = Shell.Current.GoToAsync("details"); }
}
public sealed class CatalogService {
  private readonly HttpClient client;
  public CatalogService(HttpClient client) { this.client = client; }
  public Task<List<Customer>?> GetCustomersAsync() => client.GetFromJsonAsync<List<Customer>>("customers");
}
